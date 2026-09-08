// Specs for the frame-key provider's REPLAY surface (slice 6.3 / plan §7.2) —
// run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/mlsCallKeys.test.ts
//
// These drive the REAL `MlsKeyProvider` against the REAL `BaseKeyProvider`
// (livekit-client 2.15.13 instantiates headless, and Node's WebCrypto imports
// raw HKDF material), so the base class's storage order is under test here,
// not a stand-in for it. `FakeWorker` models BOTH channels a key can reach the
// worker by — the install (`KeyProviderEvent.SetKey`) and the replay
// (`getKeys()`) — so a divergence between what we installed and what we would
// replay is visible to these specs rather than only to a live call.
//
// The hole they pin — a local send-index regression that only appears after
// the 16-slot keyring wraps:
//
//   `BaseKeyProvider.onSetEncryptionKey` stores into a Map keyed
//   `${identity}-${keyIndex}`, and `Map.set` on an existing key keeps the
//   ORIGINAL insertion position. From epoch 16 on, the local identity's
//   entries are frozen at `local-0 … local-15`, so the base `getKeys()` ends
//   on `local-15` — epoch 15's material — forever.
//
//   `E2EEManager` replays `getKeys()` into the worker on every `enable` ack
//   (posted for every remote `TrackPublished` and for every remote publication
//   on each `ConnectionState.Connected`) and on every `SignalConnected`. Each
//   replayed `setKey` moves the recipient's `currentKeyIndex`, and the encoder
//   publishes under `cryptoKeyRing[currentKeyIndex]`.
//
//   So at epoch >= 16, one peer unmuting was enough to drop this device back
//   onto epoch 15's key: a member removed at epoch 16-30 still holds it and
//   could read the media (locked decision 7), while a member added after epoch
//   15 raises `MissingKey ... at index 15`. The loud side is the SAFE one; the
//   removed member's side is silent.
//
// Everything below is about what a REPLAY does, or about the two ways this
// device can end up publishing under a key it should not: an epoch that
// carries no entry for us, and an install the group has already moved past.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeyInfo } from "livekit-client";
import { KeyProviderEvent } from "livekit-client";

import {
  type InstalledKey,
  MissingLocalFrameKeyError,
  MlsKeyProvider,
  orderForInstall,
  retainedKeyIds,
} from "./mlsCallKeys.ts";

const LOCAL = "alice:dev-a";
const BOB = "bob:dev-b";
const CAROL = "carol:dev-c";
const GROUP = "group-1";

/** `KEY_PROVIDER_DEFAULTS.keyringSize` — livekit-client e2ee/constants.ts:39. */
const KEYRING_SIZE = 16;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One `MlsFrameKey`, with material unique per (identity, epoch). */
function key(identity: string, epoch: number) {
  const [user_id, device_id] = identity.split(":");
  // 32 bytes of distinct, deterministic material -> unpadded standard base64.
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] =
      (identity.charCodeAt(i % identity.length) + epoch * 7 + i) & 0xff;
  }
  const frame_key_b64 = Buffer.from(bytes)
    .toString("base64")
    .replace(/=+$/, "");
  return {
    livekit_identity: identity,
    user_id,
    device_id,
    key_index: epoch % KEYRING_SIZE,
    epoch,
    frame_key_b64,
  };
}

/** The §7.2 egress for one epoch: current roster + the previous epoch's. */
function frameKeys(
  epoch: number,
  roster: string[],
  previousRoster = roster,
  groupId = GROUP,
) {
  return {
    group_id: groupId,
    epoch,
    keys: roster.map((id) => key(id, epoch)),
    previous: epoch > 0 ? previousRoster.map((id) => key(id, epoch - 1)) : [],
  };
}

/** A readable `identity@eN` label for whichever epoch's material a key is. */
function labelled(provider: MlsKeyProvider) {
  const labels = new Map<CryptoKey, string>();
  let applying: ReturnType<typeof frameKeys> | undefined;
  provider.on(KeyProviderEvent.SetKey, (info: KeyInfo) => {
    const entry = [
      ...(applying?.previous ?? []),
      ...(applying?.keys ?? []),
    ].find(
      (e) =>
        e.livekit_identity === info.participantIdentity &&
        e.key_index === info.keyIndex,
    );
    labels.set(
      info.key,
      entry ? `${entry.livekit_identity}@e${entry.epoch}` : "unknown",
    );
  });
  return {
    /** Run one install with the source epoch in scope for labelling. */
    async during<T>(
      keys: ReturnType<typeof frameKeys>,
      run: () => Promise<T>,
    ): Promise<T> {
      applying = keys;
      try {
        return await run();
      } finally {
        applying = undefined;
      }
    },
    of(material: CryptoKey | undefined) {
      return material === undefined ? undefined : labels.get(material);
    },
  };
}

// ---------------------------------------------------------------------------
// A faithful model of the half of livekit's worker this defect lives in
// ---------------------------------------------------------------------------

/**
 * `ParticipantKeyHandler` (livekit-client e2ee/worker/ParticipantKeyHandler.ts):
 *
 *   setKey (:157-160)
 *     await this.setKeyFromMaterial(material, keyIndex);
 *     this.resetKeyStatus(keyIndex);           // clears that index's failures
 *
 *   setKeyFromMaterial (:168-182)
 *     const newIndex = keyIndex >= 0 ? keyIndex % this.cryptoKeyRing.length
 *                                    : this.currentKeyIndex;
 *     this.setKeySet(keySet, newIndex);          // :180 -> ring[newIndex % len]
 *     if (newIndex >= 0) this.currentKeyIndex = newIndex;
 *
 *   getKeySet (:206-208)   return this.cryptoKeyRing[keyIndex ?? currentKeyIndex]
 *
 * and `FrameCryptor.encodeFunction` (:246) encrypts under `getKeySet()` with no
 * index — i.e. `cryptoKeyRing[currentKeyIndex]`. That last line is why the
 * ORDER of a replay decides what this device publishes under.
 *
 * Failure counts are modelled too: we run `failureTolerance: 0`, so ONE
 * decryption failure invalidates an index until something calls `setKey` for
 * that exact `(identity, index)` again. Which indices a replay resets is a
 * live behavior change of the override, so it is pinned rather than incidental.
 */
class FakeKeyHandler {
  readonly ring: (CryptoKey | undefined)[] = new Array(KEYRING_SIZE).fill(
    undefined,
  );

  currentKeyIndex = 0;

  readonly failures = new Map<number, number>();

  setKey(material: CryptoKey, keyIndex = 0) {
    const newIndex =
      keyIndex >= 0 ? keyIndex % KEYRING_SIZE : this.currentKeyIndex;
    this.ring[newIndex] = material;
    this.currentKeyIndex = newIndex;
    this.resetKeyStatus(newIndex);
  }

  resetKeyStatus(keyIndex: number) {
    this.failures.set(keyIndex % KEYRING_SIZE, 0);
  }

  /** One decryption failure — with `failureTolerance: 0`, enough to latch. */
  markFailure(keyIndex: number) {
    const at = keyIndex % KEYRING_SIZE;
    this.failures.set(at, (this.failures.get(at) ?? 0) + 1);
  }

  hasInvalidKeyAtIndex(keyIndex: number) {
    return (this.failures.get(keyIndex % KEYRING_SIZE) ?? 0) > 0;
  }

  /** The key the encoder would use for the next frame. */
  sending(): CryptoKey | undefined {
    return this.ring[this.currentKeyIndex];
  }
}

/**
 * The worker's two inbound channels for a key.
 *
 *  - INSTALL: `BaseKeyProvider.onSetEncryptionKey` emits `KeyProviderEvent
 *    .SetKey`, which `E2EEManager` turns straight into a `setKey` postMessage
 *    (E2eeManager.ts:287-288). Attached once, like production.
 *  - REPLAY: on `initAck` / every `enable` ack / every `SignalConnected`,
 *    `E2EEManager` walks `keyProvider.getKeys()` and `postKey`s each entry
 *    (E2eeManager.ts:151-153, :159-161, :257-259).
 *
 * Both land at `getParticipantKeyHandler(identity).setKey(key, keyIndex)`
 * (e2ee.worker.ts:131-142). Modelling them synchronously is faithful: the
 * worker serializes every message on a FIFO mutex, so postMessage order is
 * preserved end to end.
 */
class FakeWorker {
  readonly handlers = new Map<string, FakeKeyHandler>();

  handler(identity: string): FakeKeyHandler {
    let existing = this.handlers.get(identity);
    if (!existing) {
      existing = new FakeKeyHandler();
      this.handlers.set(identity, existing);
    }
    return existing;
  }

  /** Wire the install channel — every `onSetEncryptionKey` reaches us. */
  attach(provider: MlsKeyProvider): this {
    provider.on(KeyProviderEvent.SetKey, (info: KeyInfo) => {
      assert.ok(
        info.participantIdentity,
        "sharedKey is off — every installed key must carry an identity",
      );
      this.handler(info.participantIdentity).setKey(info.key, info.keyIndex);
    });
    return this;
  }

  replay(provider: MlsKeyProvider): void {
    for (const info of provider.getKeys()) {
      this.handler(info.participantIdentity).setKey(info.key, info.keyIndex);
    }
  }

  /** `identity -> currentKeyIndex`, for comparing two workers. */
  indices(): Record<string, number> {
    return Object.fromEntries(
      [...this.handlers].map(([id, h]) => [id, h.currentKeyIndex]),
    );
  }
}

/** Install `epochs` rotations, oldest first, returning the labeller. */
async function rotateThrough(
  provider: MlsKeyProvider,
  epochs: number,
  roster: string[] = [LOCAL, BOB],
) {
  const tag = labelled(provider);
  for (let epoch = 0; epoch <= epochs; epoch++) {
    const keys = frameKeys(epoch, roster);
    await tag.during(keys, () => provider.applyKeys(keys, LOCAL));
  }
  return tag;
}

/**
 * Hold `crypto.subtle.importKey` open on demand.
 *
 * The provider checks its fence twice — on entry AND across the `#import`
 * await — and only the second check covers an install that is overtaken while
 * it is deriving. Racing two real installs and hoping the slow one lands last
 * would be a coin flip (`importKey` resolves off the threadpool), so instead
 * this parks the FIRST install inside its await window and lets the second run
 * to completion underneath it, deterministically.
 */
function importGate() {
  const real = crypto.subtle.importKey.bind(crypto.subtle);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let arming = false;
  const patched = async (...args: unknown[]) => {
    const wait = arming;
    if (wait) await held;
    return (real as (...a: unknown[]) => Promise<CryptoKey>)(...args);
  };
  Object.defineProperty(crypto.subtle, "importKey", {
    value: patched,
    configurable: true,
    writable: true,
  });
  return {
    /** The next import parks until `release()`. */
    arm() {
      arming = true;
    },
    /** Later imports run normally again. */
    disarm() {
      arming = false;
    },
    async release() {
      release();
      // Two turns: one to resume `#import`, one for the caller's continuation.
      await Promise.resolve();
      await Promise.resolve();
    },
    restore() {
      Object.defineProperty(crypto.subtle, "importKey", {
        value: real,
        configurable: true,
        writable: true,
      });
    },
  };
}

const replayIds = (provider: MlsKeyProvider) =>
  provider
    .getKeys()
    .map((i: InstalledKey) => `${i.participantIdentity}-${i.keyIndex}`);

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

test("a replay past the keyring wrap leaves the local send index on the CURRENT epoch", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 20);

  const worker = new FakeWorker();
  worker.replay(provider);

  const local = worker.handler(LOCAL);
  // Epoch 20 -> index 4. The regression parked it on 15 (epoch 15's material),
  // which is precisely a key a member removed at epochs 16-20 still holds.
  assert.equal(local.currentKeyIndex, 20 % KEYRING_SIZE);
  assert.equal(tag.of(local.sending()), `${LOCAL}@e20`);
  assert.notEqual(local.currentKeyIndex, 15);
});

test("the first wrap (epoch 16) is the boundary the regression opened at", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 16);

  const worker = new FakeWorker();
  worker.replay(provider);

  // At epoch 16 the current index is 0 — the FIRST slot the base map ever
  // filled, so the stale order put fifteen later entries after it.
  const local = worker.handler(LOCAL);
  assert.equal(local.currentKeyIndex, 0);
  assert.equal(tag.of(local.sending()), `${LOCAL}@e16`);
});

test("the replay set is the current install order, not a sixteen-epoch history", async () => {
  const provider = new MlsKeyProvider();
  await rotateThrough(provider, 20);

  const expected = orderForInstall(frameKeys(20, [LOCAL, BOB]), LOCAL).map(
    (entry) => `${entry.livekit_identity}-${entry.key_index}`,
  );

  // previous(remote) + current(remote) + current(local) — three entries, not
  // the 32 the base class had accumulated by epoch 20.
  assert.deepEqual(replayIds(provider), expected);
  assert.equal(expected.length, 3);
});

test("the LOCAL key is last in the replay, so the send-index switch stays final", async () => {
  const provider = new MlsKeyProvider();
  await rotateThrough(provider, 18, [LOCAL, BOB, CAROL]);

  const replayed = provider.getKeys();
  const localPositions = replayed
    .map((info, index) => (info.participantIdentity === LOCAL ? index : -1))
    .filter((index) => index >= 0);

  assert.deepEqual(localPositions, [replayed.length - 1]);
});

test("repeated enable acks are idempotent — the send index does not drift", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 19);

  const worker = new FakeWorker();
  // A busy call: every remote TrackPublished and every reconnect fires one.
  for (let ack = 0; ack < 8; ack++) worker.replay(provider);

  const local = worker.handler(LOCAL);
  assert.equal(local.currentKeyIndex, 19 % KEYRING_SIZE);
  assert.equal(tag.of(local.sending()), `${LOCAL}@e19`);
});

test("the install channel and the replay channel never disagree", async () => {
  // The install path (SetKey -> postKey) and the replay path (getKeys ->
  // postKey) are separate; this is the spec that would catch them drifting.
  const installed = new FakeWorker();
  const provider = new MlsKeyProvider();
  installed.attach(provider);
  await rotateThrough(provider, 21, [LOCAL, BOB, CAROL]);

  const replayed = new FakeWorker();
  replayed.replay(provider);

  assert.deepEqual(replayed.indices(), installed.indices());
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test("a since-removed sender's key is not replayed", async () => {
  const provider = new MlsKeyProvider();
  // Carol is in the group through epoch 17 — long enough for her entries to be
  // wedged into the base class's map at every index.
  const tag = labelled(provider);
  for (let epoch = 0; epoch <= 17; epoch++) {
    const keys = frameKeys(epoch, [LOCAL, BOB, CAROL]);
    await tag.during(keys, () => provider.applyKeys(keys, LOCAL));
  }

  // Epoch 18 is Remove-driven: carol is gone from BOTH the current roster and
  // the previous-epoch overlap native returns.
  const after = frameKeys(18, [LOCAL, BOB], [LOCAL, BOB]);
  await tag.during(after, () => provider.applyKeys(after, LOCAL));

  assert.deepEqual(
    provider.getKeys().filter((info) => info.participantIdentity === CAROL),
    [],
    "carol must not appear in anything LiveKit can replay",
  );

  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(
    worker.handlers.has(CAROL),
    false,
    "a replay must not re-create a removed sender's key handler",
  );
  assert.deepEqual(
    [...worker.handlers.keys()].sort(),
    [BOB, LOCAL].sort(),
    "only the current roster is keyed",
  );
});

test("a Remove-driven rotation does not leave our own previous key replayable", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 17, [LOCAL, BOB, CAROL]);

  const after = frameKeys(18, [LOCAL, BOB], [LOCAL, BOB]);
  await tag.during(after, () => provider.applyKeys(after, LOCAL));

  // `remoteInstallEntries` drops the local identity from `previous[]`, and the
  // replay must not smuggle it back in: epoch 17's local key is the one carol
  // still holds.
  const ourEntries = provider
    .getKeys()
    .filter((info) => info.participantIdentity === LOCAL);
  assert.equal(ourEntries.length, 1);
  assert.equal(tag.of(ourEntries[0].key), `${LOCAL}@e18`);

  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e18`);
});

// ---------------------------------------------------------------------------
// Add-grace
// ---------------------------------------------------------------------------

test("during an Add-grace the replay keeps us on the OLD local key", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 19);

  // Add-driven rotation to epoch 20: remotes now, our send key deferred (§1.5).
  const next = frameKeys(20, [LOCAL, BOB, CAROL]);
  await tag.during(next, () => provider.applyRemoteKeys(next, LOCAL));

  const worker = new FakeWorker();
  worker.replay(provider);

  // We are still publishing on epoch 19's key for the length of the grace, so
  // a replay landing mid-grace must not switch us early — and must not park us
  // on a wrapped-around index either.
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e19`);
  assert.equal(worker.handler(LOCAL).currentKeyIndex, 19 % KEYRING_SIZE);
  // Remotes are already at the new epoch — that is what the grace is for.
  assert.equal(tag.of(worker.handler(BOB).sending()), `${BOB}@e20`);

  // …and the deferred local install completes the switch. The provider's epoch
  // fence must admit it: it carries the SAME epoch the remotes were keyed at.
  await tag.during(next, () => provider.applyLocalKey(next, LOCAL));
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e20`);
  assert.equal(worker.handler(LOCAL).currentKeyIndex, 20 % KEYRING_SIZE);
});

test("an epoch that carries no local key FAILS LOUD and leaves the replay mirroring the worker", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 17);

  // An egress with no entry for us is the shape a REMOVED leaf takes. Resolving
  // quietly here would report the send key installed while the worker keeps
  // publishing under epoch 17's key — which every member of the group that just
  // removed us holds. It has to reach the session's fail-closed path instead.
  const headless = frameKeys(18, [BOB], [LOCAL, BOB]);
  await assert.rejects(
    () => tag.during(headless, () => provider.applyLocalKey(headless, LOCAL)),
    // The TYPE is load-bearing: the session routes only this error past the
    // re-securing debounce to a paused, non-clearable terminus.
    MissingLocalFrameKeyError,
  );

  // …and the replay still describes what the worker actually holds: blanking
  // it would leave the encoder's index wherever the last remote entry put it.
  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e17`);

  // The failed epoch was never stamped, so the correct epoch-18 egress still
  // installs rather than being refused as superseded.
  const fixed = frameKeys(18, [LOCAL, BOB], [LOCAL, BOB]);
  await tag.during(fixed, () => provider.applyLocalKey(fixed, LOCAL));
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e18`);
});

// ---------------------------------------------------------------------------
// The (group, epoch) fence
// ---------------------------------------------------------------------------

test("a superseded install is refused — an out-of-order reply cannot regress the send index", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 17, [LOCAL, BOB, CAROL]);

  // Two native pushes race: the Remove at 19 wins the IPC and installs first…
  const removeAt19 = frameKeys(19, [LOCAL, BOB], [LOCAL, BOB]);
  await tag.during(removeAt19, () => provider.applyKeys(removeAt19, LOCAL));

  // …and the Add at 18's continuation lands afterwards, carrying carol and
  // epoch 18's local key. Installing it would hand carol readable media.
  const addAt18 = frameKeys(18, [LOCAL, BOB, CAROL]);
  await tag.during(addAt18, () => provider.applyKeys(addAt18, LOCAL));

  assert.equal(tag.of(provider.getKeys().at(-1)?.key), `${LOCAL}@e19`);
  assert.deepEqual(
    provider.getKeys().filter((info) => info.participantIdentity === CAROL),
    [],
    "the superseded egress must not re-admit carol",
  );

  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e19`);
  assert.equal(worker.handler(LOCAL).currentKeyIndex, 19 % KEYRING_SIZE);
});

test("an equal epoch is admitted — the deferred and the re-asserted install both ride one", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 20);

  // Same epoch again (the session allows an equal-epoch re-assert).
  const same = frameKeys(20, [LOCAL, BOB]);
  await tag.during(same, () => provider.applyKeys(same, LOCAL));

  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e20`);
});

test("a different group RESETS the fence rather than comparing epochs against it", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 20);

  // A re-establish mints a new group whose epochs start over. Epochs are only
  // comparable within one group, so 3 here is not "older than 20".
  const fresh = frameKeys(3, [LOCAL, BOB], [LOCAL, BOB], "group-2");
  await tag.during(fresh, () => provider.applyKeys(fresh, LOCAL));

  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e3`);
  assert.equal(worker.handler(LOCAL).currentKeyIndex, 3);
  // Nothing from the old group survives into what LiveKit can replay.
  assert.equal(provider.getKeys().length, 3);
});

test("resetForGroup drops every key, so a replay during a re-establish installs nothing", async () => {
  const provider = new MlsKeyProvider();
  await rotateThrough(provider, 20, [LOCAL, BOB, CAROL]);

  provider.resetForGroup();

  assert.deepEqual(provider.getKeys(), []);
  assert.equal(provider.lastLocalScreenKey(), undefined);

  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(
    worker.handlers.size,
    0,
    "the outgoing group's send key must not survive into the negotiating window",
  );
});

// ---------------------------------------------------------------------------
// Retention + atomicity
// ---------------------------------------------------------------------------

test("the base class's retained key map is pruned to exactly what is replayable", async () => {
  const provider = new MlsKeyProvider();
  // If a LiveKit upgrade renames the private field, the prune silently becomes
  // a no-op — this is the assertion that turns that silence into a failure.
  assert.ok(
    retainedKeyIds(provider),
    "BaseKeyProvider's retained key map is no longer reachable — #pruneRetainedKeys is dead",
  );

  await rotateThrough(provider, 20, [LOCAL, BOB, CAROL]);

  // Without pruning this would hold every (identity, index) pair ever used:
  // 3 identities x 16 indices = 48 CryptoKeys, on the main thread, for the
  // life of the call.
  assert.deepEqual(
    retainedKeyIds(provider)?.sort(),
    replayIds(provider).sort(),
  );

  provider.resetForGroup();
  assert.deepEqual(retainedKeyIds(provider), []);
});

test("an entry that fails to import installs nothing at all", async () => {
  const provider = new MlsKeyProvider();
  const worker = new FakeWorker().attach(provider);
  await rotateThrough(provider, 5);
  const beforeIndices = worker.indices();
  const beforeReplay = replayIds(provider);

  // A malformed egress: the third entry's material is not base64. CAROL is new
  // at this epoch, so a partial install would both key a fresh handler and
  // leave the earlier entries in the worker unrecorded.
  const broken = frameKeys(6, [LOCAL, BOB, CAROL]);
  broken.keys[2].frame_key_b64 = "!!!!not base64!!!!";

  await assert.rejects(() => provider.applyKeys(broken, LOCAL));

  // Importing the whole set before publishing any of it is what makes this
  // atomic: a half-keyed epoch nobody recorded is exactly the divergence
  // between worker and replay set that the override exists to prevent.
  assert.deepEqual(worker.indices(), beforeIndices);
  assert.deepEqual(replayIds(provider), beforeReplay);
  assert.equal(worker.handlers.has(CAROL), false);
});

test("a replay resets the failure count on the current indices, and no longer on stale ones", async () => {
  const provider = new MlsKeyProvider();
  await rotateThrough(provider, 20);

  const worker = new FakeWorker();
  worker.replay(provider);
  const bob = worker.handler(BOB);

  // With `failureTolerance: 0` one failure invalidates an index until a
  // `setKey` for that exact pair lands. Latch the CURRENT index and a stale one.
  bob.markFailure(20 % KEYRING_SIZE);
  bob.markFailure(7);
  assert.equal(bob.hasInvalidKeyAtIndex(20 % KEYRING_SIZE), true);
  assert.equal(bob.hasInvalidKeyAtIndex(7), true);

  worker.replay(provider);

  // The current epoch's index still heals — that is the path a rotation-skew
  // latch recovers by, and it must survive the narrowing.
  assert.equal(bob.hasInvalidKeyAtIndex(20 % KEYRING_SIZE), false);
  // A stale index is no longer swept clean as a side effect. This IS a
  // behavior change: the old 16-epoch replay reset every index of every
  // identity on every ack.
  assert.equal(bob.hasInvalidKeyAtIndex(7), true);
});

test("a keyless epoch reached through applyKeys leaves the remotes installed and the fence stamped", async () => {
  // The composite path, not just `applyLocalKey` on its own: `applyRemoteKeys`
  // has already succeeded and stamped epoch 18 by the time the local half
  // throws, so this pins the whole end state the session is left holding.
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 17);

  const headless = frameKeys(18, [BOB], [LOCAL, BOB]);
  await assert.rejects(
    () => tag.during(headless, () => provider.applyKeys(headless, LOCAL)),
    MissingLocalFrameKeyError,
  );

  const worker = new FakeWorker();
  worker.replay(provider);
  // Remotes advanced; our send key did NOT, and still mirrors the worker.
  assert.equal(tag.of(worker.handler(BOB).sending()), `${BOB}@e18`);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e17`);

  // The fence is stamped at 18 by the remote half, so the equal-epoch retry
  // still gets in rather than being refused as superseded.
  const fixed = frameKeys(18, [LOCAL, BOB], [LOCAL, BOB]);
  await tag.during(fixed, () => provider.applyLocalKey(fixed, LOCAL));
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e18`);
});

test("a REMOTE install overtaken inside its import window cannot land", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 17);
  const gate = importGate();
  try {
    // Epoch 18 is admitted on entry (the fence is at 17), then parks.
    gate.arm();
    const inFlight = provider.applyRemoteKeys(
      frameKeys(18, [LOCAL, BOB, CAROL]),
      LOCAL,
    );
    await Promise.resolve();
    gate.disarm();

    // 19 completes underneath it and moves the fence.
    const removeAt19 = frameKeys(19, [LOCAL, BOB], [LOCAL, BOB]);
    await tag.during(removeAt19, () => provider.applyKeys(removeAt19, LOCAL));

    await gate.release();
    await inFlight;
  } finally {
    gate.restore();
  }

  assert.deepEqual(
    provider.getKeys().filter((info) => info.participantIdentity === CAROL),
    [],
    "the overtaken install must not re-admit a member 19 removed",
  );
  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e19`);
});

test("a LOCAL install overtaken inside its import window cannot regress the send index", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 17);
  const gate = importGate();
  try {
    gate.arm();
    const inFlight = provider.applyLocalKey(frameKeys(18, [LOCAL, BOB]), LOCAL);
    await Promise.resolve();
    gate.disarm();

    const removeAt19 = frameKeys(19, [LOCAL, BOB], [LOCAL, BOB]);
    await tag.during(removeAt19, () => provider.applyKeys(removeAt19, LOCAL));

    await gate.release();
    await inFlight;
  } finally {
    gate.restore();
  }

  // Epoch 18's local key is the one the member 19 removed still holds.
  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e19`);
  assert.equal(worker.handler(LOCAL).currentKeyIndex, 19 % KEYRING_SIZE);
});

test("an entry with no LiveKit identity is refused before anything is published", async () => {
  // `onSetEncryptionKey` throws on a keyless identity under `sharedKey:false`,
  // and it throws from inside `#publish` — after the replay slot is assigned.
  // Catching it in `#import` is what keeps `#publish` unable to fail, so the
  // replay set can never advertise keys the worker never received.
  const provider = new MlsKeyProvider();
  const worker = new FakeWorker().attach(provider);
  await rotateThrough(provider, 4);
  const beforeIndices = worker.indices();
  const beforeReplay = replayIds(provider);

  const broken = frameKeys(5, [LOCAL, BOB]);
  broken.previous[1].livekit_identity = "";

  await assert.rejects(
    () => provider.applyKeys(broken, LOCAL),
    /carried no LiveKit identity/,
  );
  assert.deepEqual(worker.indices(), beforeIndices);
  assert.deepEqual(replayIds(provider), beforeReplay);
});

test("an egress with no usable epoch fails closed rather than turning the fence off", async () => {
  const provider = new MlsKeyProvider();
  await rotateThrough(provider, 20);

  const malformed = frameKeys(20, [LOCAL, BOB]);
  (malformed as { epoch: unknown }).epoch = undefined;

  // Admitting it unfenced would leave the fence parked on 20 while every LATER
  // superseded install sailed through — the field would switch the fence off
  // rather than pass through it.
  await assert.rejects(
    () => provider.applyKeys(malformed, LOCAL),
    /no usable epoch/,
  );
  assert.equal(provider.getKeys().length, 3);
});

// ---------------------------------------------------------------------------
// Sanity: a replay must reproduce a fresh install exactly
// ---------------------------------------------------------------------------

test("a replay lands the whole roster exactly where a fresh install does", async () => {
  const roster = [LOCAL, BOB, CAROL];

  const installed = new FakeWorker();
  const fresh = new MlsKeyProvider();
  const freshTag = labelled(fresh);
  const first = frameKeys(21, roster);
  // A device joining at epoch 21 installs once, from scratch.
  await freshTag.during(first, () => fresh.applyKeys(first, LOCAL));
  installed.replay(fresh);

  const replayed = new FakeWorker();
  const long = new MlsKeyProvider();
  const longTag = await rotateThrough(long, 21, roster);
  replayed.replay(long);

  for (const identity of roster) {
    assert.equal(
      replayed.handler(identity).currentKeyIndex,
      installed.handler(identity).currentKeyIndex,
      `${identity} must end on the same index either way`,
    );
    assert.equal(
      longTag.of(replayed.handler(identity).sending()),
      freshTag.of(installed.handler(identity).sending()),
      `${identity} must end on the same epoch's material either way`,
    );
  }
});
