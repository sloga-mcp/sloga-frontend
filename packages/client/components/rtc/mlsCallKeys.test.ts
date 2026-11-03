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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { KeyInfo } from "livekit-client";
import { KeyProviderEvent } from "livekit-client";

import {
  type InstalledKey,
  type LocalScreenKey,
  LocalKeyAckError,
  MissingLocalFrameKeyError,
  MlsKeyProvider,
  orderForInstall,
  retainedKeyIds,
} from "./mlsCallKeys.ts";
import { createWorkerAckTracker } from "./webkitSenderHold.ts";

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
  // The roster carries our screen-leg entry so the leg key is really set
  // before the reset; without one the undefined check below holds vacuously.
  const LEG = `${LOCAL}:screen`;
  const provider = new MlsKeyProvider();
  await rotateThrough(provider, 20, [LOCAL, BOB, CAROL, LEG]);
  assert.equal(provider.lastLocalScreenKey()?.epoch, 20);

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

test("an epoch with no screen-leg entry clears the leg key instead of keeping the superseded one", async () => {
  const LEG = `${LOCAL}:screen`;
  const provider = new MlsKeyProvider();
  const pushed: number[] = [];
  provider.onLocalScreenKey = (k) => {
    pushed.push(k.epoch);
  };
  await rotateThrough(provider, 17, [LOCAL, BOB, LEG]);
  assert.equal(provider.lastLocalScreenKey()?.epoch, 17);
  assert.equal(pushed.at(-1), 17);

  // Epoch 18 carries our send key but no leg entry. Keeping epoch 17's leg key
  // would hand a share started now a superseded key; it must read as no key.
  const legless = frameKeys(18, [LOCAL, BOB], [LOCAL, BOB, LEG]);
  const before = pushed.length;
  await provider.applyKeys(legless, LOCAL);
  assert.equal(provider.lastLocalScreenKey(), undefined);
  assert.equal(
    pushed.length,
    before,
    "no leg key may be pushed for an epoch that carries none",
  );

  // The next epoch that does carry the entry records and pushes it again.
  const restored = frameKeys(19, [LOCAL, BOB, LEG], [LOCAL, BOB]);
  await provider.applyKeys(restored, LOCAL);
  assert.equal(provider.lastLocalScreenKey()?.epoch, 19);
  assert.equal(pushed.at(-1), 19);
});

// ---------------------------------------------------------------------------
// The leg key push (Android plan §5.2)
//
// `applyLocalKey` records this device's leg key and hands it to
// `onLocalScreenKey`, which `state.tsx` forwards to the native leg. On a
// Remove-driven rotation the order and the awaits ARE the control: until the
// phone has the new key, it encrypts the share under one the removed member
// still holds.
// ---------------------------------------------------------------------------

/** This device's screen-leg identity — e2ee-core's `{user}:{device}:screen`. */
const LOCAL_LEG = `${LOCAL}:screen`;

/** A promise settled from outside, for holding a leg push open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask and the next macrotask run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test(
  "🔴 the leg key is recorded BEFORE the push, so a share started mid-push gets the NEW key",
  { timeout: 2000 },
  async () => {
    // `lastLocalScreenKey()` is what a leg starting mid-call connects on. Were
    // it still the OLD epoch's while the push is in flight, a start in that
    // window connects on the key the member this rotation removed holds; the
    // post-connect sync sees "no change" and the listener skipped the
    // not-yet-active leg, so nothing re-keys it until the next rotation.
    const provider = new MlsKeyProvider();
    await rotateThrough(provider, 17, [LOCAL, BOB, CAROL, LOCAL_LEG]);
    assert.equal(provider.lastLocalScreenKey()?.epoch, 17);

    const push = deferred();
    const entered = deferred<LocalScreenKey>();
    let inListener: LocalScreenKey | undefined;
    provider.onLocalScreenKey = (k) => {
      inListener = provider.lastLocalScreenKey();
      entered.resolve(k);
      return push.promise;
    };

    // Remove-driven: carol leaves at 18.
    const roster = [LOCAL, BOB, LOCAL_LEG];
    const install = provider.applyKeys(frameKeys(18, roster, roster), LOCAL);
    const pushed = await entered.promise;
    const midPush = provider.lastLocalScreenKey();
    push.resolve();
    await install;

    assert.deepEqual(pushed, {
      keyB64: key(LOCAL_LEG, 18).frame_key_b64,
      keyIndex: 18 % KEYRING_SIZE,
      epoch: 18,
      groupId: GROUP,
    });
    assert.deepEqual(
      inListener,
      pushed,
      "the listener must already read the key it is being handed",
    );
    assert.deepEqual(
      midPush,
      pushed,
      "a start reading the key while the push is in flight must get epoch 18",
    );
  },
);

test(
  "🔴 a rotation does not resolve until the leg has taken the new key",
  { timeout: 2000 },
  async () => {
    // The push is awaited so a Remove-driven rotation does not report the
    // local key installed while the phone still encrypts under the key the
    // removed member holds. Dropping either await (on the push, or on the
    // step that makes it) resolves the install with the push in flight.
    const provider = new MlsKeyProvider();
    await rotateThrough(provider, 17, [LOCAL, BOB, CAROL, LOCAL_LEG]);

    const push = deferred();
    const entered = deferred();
    provider.onLocalScreenKey = () => {
      entered.resolve();
      return push.promise;
    };

    let installed = false;
    const roster = [LOCAL, BOB, LOCAL_LEG];
    const install = provider
      .applyKeys(frameKeys(18, roster, roster), LOCAL)
      .then(() => {
        installed = true;
      });
    await entered.promise;
    await settle();
    assert.equal(
      installed,
      false,
      "the install resolved while the leg push was still pending",
    );

    push.resolve();
    await install;
    assert.equal(installed, true);
  },
);

test(
  "🔴 a leg push that REJECTS fails the install loudly, with the new key still current",
  { timeout: 2000 },
  async () => {
    // The listener is meant to own its failure (stop the leg, toast,
    // resolve). A rejection is the documented backstop: it must reach the
    // session's media-error path, never vanish. The recorded key stays the
    // NEW one: it answers "what should a leg use now", not "what landed".
    const provider = new MlsKeyProvider();
    await rotateThrough(provider, 17, [LOCAL, BOB, CAROL, LOCAL_LEG]);

    provider.onLocalScreenKey = async () => {
      await Promise.resolve();
      throw new Error("leg bridge refused the key");
    };

    const roster = [LOCAL, BOB, LOCAL_LEG];
    await assert.rejects(
      () => provider.applyKeys(frameKeys(18, roster, roster), LOCAL),
      /leg bridge refused the key/,
    );
    assert.equal(provider.lastLocalScreenKey()?.epoch, 18);
  },
);

test(
  "🔴 the deferred local install awaits the whole leg-key step, and a throwing listener fails it",
  { timeout: 2000 },
  async () => {
    // `applyLocalKey` is the Add-grace's deferred half and the only caller of
    // the leg-key step, so it is held to the rule on its own: it resolves
    // only once that step has, and a failure inside the step (here a listener
    // that throws synchronously) rejects it, rather than escaping as an
    // unhandled rejection beside an install that reported success.
    const provider = new MlsKeyProvider();
    await rotateThrough(provider, 17, [LOCAL, BOB, LOCAL_LEG]);

    // Add-driven: carol joins at 18. Remotes now, our send key after grace.
    const addAt18 = frameKeys(
      18,
      [LOCAL, BOB, CAROL, LOCAL_LEG],
      [LOCAL, BOB, LOCAL_LEG],
    );
    const pushes: number[] = [];
    const push = deferred();
    const entered = deferred();
    provider.onLocalScreenKey = (k) => {
      pushes.push(k.epoch);
      entered.resolve();
      return push.promise;
    };
    await provider.applyRemoteKeys(addAt18, LOCAL);
    assert.deepEqual(pushes, [], "the remote half must not move the leg key");
    assert.equal(provider.lastLocalScreenKey()?.epoch, 17);

    let installed = false;
    const install = provider.applyLocalKey(addAt18, LOCAL).then(() => {
      installed = true;
    });
    await entered.promise;
    await settle();
    assert.equal(
      installed,
      false,
      "the deferred install resolved while the leg push was still pending",
    );
    push.resolve();
    await install;
    assert.deepEqual(pushes, [18]);

    // A synchronous throw: the same failure, with no promise to await.
    provider.onLocalScreenKey = () => {
      throw new Error("leg bridge threw");
    };
    const roster = [LOCAL, BOB, CAROL, LOCAL_LEG];
    await assert.rejects(
      () => provider.applyLocalKey(frameKeys(19, roster, roster), LOCAL),
      /leg bridge threw/,
    );
    assert.equal(provider.lastLocalScreenKey()?.epoch, 19);
  },
);

test("🔴 resetForGroup forgets the leg key, so the next install pushes it afresh", async () => {
  // The group the key belongs to is being REPLACED (a re-establish, a
  // removed-self rejoin): answering `lastLocalScreenKey()` with its key would
  // hand a share started in the negotiating window the outgoing group's
  // material. The roster carries a leg entry so the key is really set before
  // the reset; without one the check below holds vacuously.
  const provider = new MlsKeyProvider();
  const pushed: number[] = [];
  provider.onLocalScreenKey = (k) => {
    pushed.push(k.epoch);
  };
  await rotateThrough(provider, 17, [LOCAL, BOB, LOCAL_LEG]);
  assert.equal(provider.lastLocalScreenKey()?.epoch, 17);

  provider.resetForGroup();
  assert.equal(provider.lastLocalScreenKey(), undefined);

  // Nothing is current after a reset, so even an identical key is pushed
  // again rather than swallowed as an equal-epoch re-assert.
  const before = pushed.length;
  await provider.applyKeys(frameKeys(17, [LOCAL, BOB, LOCAL_LEG]), LOCAL);
  assert.equal(pushed.length, before + 1);
  assert.equal(provider.lastLocalScreenKey()?.epoch, 17);
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

test(
  "🔴 a LOCAL install overtaken inside its import window neither pushes nor records its leg key",
  { timeout: 2000 },
  async () => {
    // The leg push has to sit BEHIND the fence re-check that follows the
    // import. Ahead of it, the overtaken epoch-18 install hands the phone
    // epoch 18's leg key after 19 already pushed its own, and overwrites
    // `lastLocalScreenKey()` with it, so the next share connects on a key the
    // member 19 removed still holds.
    const provider = new MlsKeyProvider();
    await rotateThrough(provider, 17, [LOCAL, BOB, CAROL, LOCAL_LEG]);
    const pushed: number[] = [];
    provider.onLocalScreenKey = (k) => {
      pushed.push(k.epoch);
    };
    const gate = importGate();
    try {
      gate.arm();
      const inFlight = provider.applyLocalKey(
        frameKeys(18, [LOCAL, BOB, CAROL, LOCAL_LEG]),
        LOCAL,
      );
      await Promise.resolve();
      gate.disarm();

      // Remove-driven: carol leaves at 19, which completes underneath it.
      const roster = [LOCAL, BOB, LOCAL_LEG];
      await provider.applyKeys(frameKeys(19, roster, roster), LOCAL);
      assert.deepEqual(pushed, [19]);

      await gate.release();
      await inFlight;
    } finally {
      gate.restore();
    }

    assert.deepEqual(
      pushed,
      [19],
      "the overtaken install must not push epoch 18's leg key",
    );
    assert.equal(provider.lastLocalScreenKey()?.epoch, 19);
    assert.deepEqual(provider.lastLocalScreenKey(), {
      keyB64: key(LOCAL_LEG, 19).frame_key_b64,
      keyIndex: 19 % KEYRING_SIZE,
      epoch: 19,
      groupId: GROUP,
    });
  },
);

test(
  "🔴 the primary's LOCAL send key is published before the leg push, so a stalled bridge cannot hold it back",
  { timeout: 2000 },
  async () => {
    // The leg push crosses into native and has no timeout of its own. The
    // primary's switch onto the new epoch (the forward-secrecy step on a
    // Remove) must already have reached the worker when that call is made:
    // the other way round, a bridge that never answers leaves the WebView
    // publishing under the key the removed member holds.
    const provider = new MlsKeyProvider();
    const worker = new FakeWorker().attach(provider);
    const tag = await rotateThrough(provider, 17, [
      LOCAL,
      BOB,
      CAROL,
      LOCAL_LEG,
    ]);
    assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e17`);

    // A leg bridge that never answers.
    const entered = deferred<LocalScreenKey>();
    let sendingAtPush: string | undefined;
    provider.onLocalScreenKey = (k) => {
      sendingAtPush = tag.of(worker.handler(LOCAL).sending());
      entered.resolve(k);
      return new Promise<void>(() => {});
    };

    // Remove-driven: carol leaves at 18.
    const roster = [LOCAL, BOB, LOCAL_LEG];
    const removeAt18 = frameKeys(18, roster, roster);
    let installed = false;
    void tag
      .during(removeAt18, () => provider.applyKeys(removeAt18, LOCAL))
      .then(() => {
        installed = true;
      });
    const pushedKey = await entered.promise;
    await settle();

    assert.equal(pushedKey.epoch, 18);
    assert.equal(installed, false, "the leg push must still be pending here");
    assert.equal(
      sendingAtPush,
      `${LOCAL}@e18`,
      "the primary must already send under epoch 18 when the leg push starts",
    );
    assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e18`);
    assert.equal(worker.handler(LOCAL).currentKeyIndex, 18 % KEYRING_SIZE);

    // A replay landing while the bridge hangs also keeps the primary on 18.
    const replayed = new FakeWorker();
    replayed.replay(provider);
    assert.equal(tag.of(replayed.handler(LOCAL).sending()), `${LOCAL}@e18`);
  },
);

test(
  "a re-assert at the same group and epoch with a changed leg key pushes it again",
  { timeout: 2000 },
  async () => {
    // The skip-if-unchanged check exists so an equal-epoch re-assert does not
    // re-key the sender cryptor for nothing, and it has to compare the whole
    // key. Cut to the epoch, a re-assert carrying new material or a new index
    // at the same (group, epoch) is swallowed: `lastLocalScreenKey()` reports
    // the new key while the phone keeps encrypting under the old one.
    const provider = new MlsKeyProvider();
    const roster = [LOCAL, BOB, LOCAL_LEG];
    await rotateThrough(provider, 17, roster);
    const pushed: LocalScreenKey[] = [];
    provider.onLocalScreenKey = (k) => {
      pushed.push(k);
    };

    /** Epoch 17's egress with our leg entry patched. */
    const withLeg = (patch: { frame_key_b64?: string; key_index?: number }) => {
      const fk = frameKeys(17, roster);
      return {
        ...fk,
        keys: fk.keys.map((k) =>
          k.livekit_identity === LOCAL_LEG ? { ...k, ...patch } : k,
        ),
      };
    };

    // An identical re-assert is still swallowed, so the check is live.
    await provider.applyKeys(frameKeys(17, roster), LOCAL);
    assert.deepEqual(pushed, []);

    // Same group, epoch and index; new material.
    const material = key(`${BOB}:screen`, 17).frame_key_b64;
    assert.notEqual(material, key(LOCAL_LEG, 17).frame_key_b64);
    await provider.applyKeys(withLeg({ frame_key_b64: material }), LOCAL);
    assert.deepEqual(
      pushed,
      [
        {
          keyB64: material,
          keyIndex: 17 % KEYRING_SIZE,
          epoch: 17,
          groupId: GROUP,
        },
      ],
      "new material at the same epoch must be pushed",
    );

    // Same group, epoch and material; new index.
    const index = (17 + 1) % KEYRING_SIZE;
    await provider.applyKeys(
      withLeg({ frame_key_b64: material, key_index: index }),
      LOCAL,
    );
    assert.equal(
      pushed.length,
      2,
      "a new index at the same epoch must be pushed",
    );
    assert.deepEqual(pushed[1], {
      keyB64: material,
      keyIndex: index,
      epoch: 17,
      groupId: GROUP,
    });
    assert.deepEqual(provider.lastLocalScreenKey(), pushed[1]);
  },
);

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

// ---------------------------------------------------------------------------
// iOS raw-bytes mode (phase 2: D2, R3, R13a)
//
// On WebKit the worker gets each frame key as raw HKDF bytes and imports them
// itself (the patched livekit), because a `CryptoKey` crossing `postMessage`
// rests on a keychain-wrapped clone nobody has proven while the phone is
// locked. The main-thread import stays as VALIDATION, and the local send key
// counts as installed only once the worker acks it. Chromium shells construct
// the provider with no options and must see no change at all.
// ---------------------------------------------------------------------------

/**
 * The `data` of a page→worker `setKey`, as the PATCHED `E2EEManager.postKey`
 * builds it (livekit-client.esm.mjs, the Sloga D2/C5 hunk): `keyBytes` present
 * → the bytes and NO `key` field; absent → today's `CryptoKey` message.
 *
 * `postMessage` structured-clones synchronously, so the bytes are COPIED here,
 * at post time — zeroing an array after it was posted must not reach the
 * worker, and zeroing an array before a replay posts it must.
 *
 * Every replay site in the dist (`initAck`, `enable`, `SignalConnected`) is
 * `keyProvider.getKeys().forEach(keyInfo => this.postKey(keyInfo))`, so
 * `PostLog.replay` is the same function over the same objects.
 */
type SetKeyData =
  | { participantIdentity?: string; keyIndex?: number; keyBytes: Uint8Array }
  | { participantIdentity?: string; keyIndex?: number; key: CryptoKey };

function postKeyData(info: KeyInfo): SetKeyData {
  return info.keyBytes !== undefined
    ? {
        participantIdentity: info.participantIdentity,
        keyIndex: info.keyIndex,
        keyBytes: new Uint8Array(info.keyBytes),
      }
    : {
        participantIdentity: info.participantIdentity,
        keyIndex: info.keyIndex,
        key: info.key,
      };
}

/** What reached the worker, by either channel. */
class PostLog {
  readonly posts: SetKeyData[] = [];

  attach(provider: MlsKeyProvider): this {
    provider.on(KeyProviderEvent.SetKey, (info: KeyInfo) => {
      this.posts.push(postKeyData(info));
    });
    return this;
  }

  replay(provider: MlsKeyProvider): SetKeyData[] {
    const replayed = provider.getKeys().map(postKeyData);
    this.posts.push(...replayed);
    return replayed;
  }
}

/** The bytes a raw-mode post carried; fails if it carried a `CryptoKey`. */
function bytesPosted(data: SetKeyData | undefined): Uint8Array {
  assert.ok(data, "nothing was posted");
  assert.ok(!("key" in data), "a raw-mode post must not carry a CryptoKey");
  assert.ok("keyBytes" in data, "a raw-mode post must carry keyBytes");
  return data.keyBytes;
}

/** The raw material `key(identity, epoch)` encodes. */
function bytesOf(identity: string, epoch: number): Uint8Array {
  return new Uint8Array(
    Buffer.from(key(identity, epoch).frame_key_b64, "base64"),
  );
}

const isZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

/** An ack wait that always says yes, the way a healthy worker answers. */
const ackedAlways = () => Promise.resolve(true);

const rawProvider = (
  awaitKeyAck: (
    identity: string,
    keyIndex: number,
  ) => Promise<boolean> = ackedAlways,
) => new MlsKeyProvider({ rawKeyBytes: true, awaitKeyAck });

/** The served `keyBytes` of each replay entry, by `identity-index`. */
function servedBytes(provider: MlsKeyProvider): Map<string, Uint8Array> {
  return new Map(
    provider.getKeys().map((info) => {
      assert.ok(info.keyBytes, "a raw-mode entry must carry keyBytes");
      return [`${info.participantIdentity}-${info.keyIndex}`, info.keyBytes];
    }),
  );
}

/** Record the argument count of every `onSetEncryptionKey` call. */
function spyArity(provider: MlsKeyProvider): number[] {
  const arities: number[] = [];
  const target = provider as unknown as {
    onSetEncryptionKey: (...args: unknown[]) => void;
  };
  const real = target.onSetEncryptionKey.bind(provider);
  target.onSetEncryptionKey = (...args: unknown[]) => {
    arities.push(args.length);
    real(...args);
  };
  return arities;
}

/** Make the `n`th `crypto.subtle.importKey` call from now reject. */
function failNthImport(n: number) {
  const real = crypto.subtle.importKey.bind(crypto.subtle);
  let calls = 0;
  const patched = async (...args: unknown[]) => {
    calls++;
    if (calls === n) throw new DOMException("refused", "DataError");
    return (real as (...a: unknown[]) => Promise<CryptoKey>)(...args);
  };
  Object.defineProperty(crypto.subtle, "importKey", {
    value: patched,
    configurable: true,
    writable: true,
  });
  return {
    restore() {
      Object.defineProperty(crypto.subtle, "importKey", {
        value: real,
        configurable: true,
        writable: true,
      });
    },
  };
}

test("raw-bytes mode without an ack wait refuses to construct", () => {
  // Raw bytes with nothing to confirm the install would claim the send key
  // installed on the post alone — the claim the ack exists to back.
  assert.throws(() => new MlsKeyProvider({ rawKeyBytes: true }), TypeError);
  assert.throws(
    () => new MlsKeyProvider({ rawKeyBytes: true, awaitKeyAck: undefined }),
    /requires awaitKeyAck/,
  );
  // The Chromium wiring (state.tsx hands every shell the tracker's wait):
  // raw off with an ack wait present constructs, and is the default mode.
  assert.doesNotThrow(
    () => new MlsKeyProvider({ rawKeyBytes: false, awaitKeyAck: ackedAlways }),
  );
});

test("🔴 default mode is unchanged: a CryptoKey on every post, no bytes, no ack gating", async () => {
  // Both ways a Chromium shell can construct it: bare, and with the tracker's
  // wait handed in but raw off. A wait that always REFUSES is the probe: were
  // default mode ack-gated, the install below would reject.
  let asked = 0;
  const refuse = () => {
    asked++;
    return Promise.resolve(false);
  };
  const variants = [
    new MlsKeyProvider(),
    new MlsKeyProvider({ rawKeyBytes: false, awaitKeyAck: refuse }),
  ];
  for (const provider of variants) {
    const log = new PostLog().attach(provider);
    const arities = spyArity(provider);
    await rotateThrough(provider, 18, [LOCAL, BOB, CAROL]);

    assert.ok(arities.length > 0);
    assert.ok(
      arities.every((n) => n === 3),
      `default mode must call onSetEncryptionKey(key, identity, index), got arities ${[...new Set(arities)]}`,
    );
    for (const info of provider.getKeys()) {
      assert.equal("keyBytes" in info, false, "no keyBytes on a default entry");
      assert.ok(info.key instanceof CryptoKey);
    }
    log.replay(provider);
    for (const data of log.posts) {
      assert.equal(
        "keyBytes" in data,
        false,
        "a default post carries no bytes",
      );
      assert.ok("key" in data && data.key instanceof CryptoKey);
    }
    assert.equal(provider.getOptions().ratchetWindowSize, 0);
  }
  assert.equal(asked, 0, "default mode must never consult awaitKeyAck (R3)");
});

test("🔴 raw mode hands the worker BYTES on the install and on every replay, never a CryptoKey alone", async () => {
  const roster = [LOCAL, BOB, CAROL];
  const provider = rawProvider();
  const log = new PostLog().attach(provider);
  const arities = spyArity(provider);
  await rotateThrough(provider, 20, roster);

  assert.ok(arities.length > 0);
  assert.ok(
    arities.every((n) => n === 4),
    "raw mode must pass keyBytes as onSetEncryptionKey's 4th argument",
  );
  for (const data of log.posts) assert.equal(bytesPosted(data).length, 32);
  // The install's last post is our epoch-20 send key, with its exact bytes.
  const last = log.posts.at(-1);
  assert.equal(last?.participantIdentity, LOCAL);
  assert.deepEqual(bytesPosted(last), bytesOf(LOCAL, 20));

  // Twenty rotations of replacing and zeroing later, a replay still posts the
  // CURRENT set's real bytes: nothing served was zeroed by mistake (a replay
  // of zeros would key the encoder with a key nobody else holds).
  const replayed = log.replay(provider);
  assert.deepEqual(
    replayed.map((data) => ({
      id: data.participantIdentity,
      index: data.keyIndex,
      bytes: bytesPosted(data),
    })),
    orderForInstall(frameKeys(20, roster), LOCAL).map((entry) => ({
      id: entry.livekit_identity,
      index: entry.key_index,
      bytes: bytesOf(entry.livekit_identity, entry.epoch),
    })),
  );
  assert.equal(provider.getOptions().ratchetWindowSize, 0);
});

test("🔴 raw mode zeroes every array an install replaces, and none it still serves", async () => {
  const roster = [LOCAL, BOB, CAROL];
  const provider = rawProvider();
  await rotateThrough(provider, 17, roster);
  const at17 = servedBytes(provider);
  const local17 = at17.get(`${LOCAL}-${17 % KEYRING_SIZE}`);
  assert.ok(local17 && !isZero(local17));
  assert.ok([...at17.values()].every((b) => !isZero(b)));

  // Add-grace: the remote set is replaced, our send key is NOT.
  await provider.applyRemoteKeys(frameKeys(18, roster), LOCAL);
  for (const [id, bytes] of at17) {
    if (bytes === local17) continue;
    assert.ok(isZero(bytes), `the replaced remote array ${id} must be zeroed`);
  }
  assert.deepEqual(
    local17,
    bytesOf(LOCAL, 17),
    "the local key still in force must NOT be zeroed",
  );
  assert.deepEqual(
    bytesPosted(new PostLog().replay(provider).at(-1)),
    bytesOf(LOCAL, 17),
    "a replay during the grace still posts the old local key's real bytes",
  );

  // The deferred local install replaces it.
  await provider.applyLocalKey(frameKeys(18, roster), LOCAL);
  assert.ok(isZero(local17), "the replaced local array must be zeroed");

  // An equal-epoch re-assert replaces the whole set at the SAME ids — the
  // case the base class's prune cannot see (its map now points at the new
  // arrays), so only the replace itself can zero the old ones.
  const at18 = servedBytes(provider);
  await provider.applyKeys(frameKeys(18, roster), LOCAL);
  for (const [id, bytes] of at18) {
    assert.ok(isZero(bytes), `the re-asserted ${id} array must be zeroed`);
  }
  for (const [id, bytes] of servedBytes(provider)) {
    assert.ok(!isZero(bytes), `the served ${id} array must be intact`);
  }
});

test("raw mode: resetForGroup and a group switch zero every dropped array", async () => {
  const provider = rawProvider();
  await rotateThrough(provider, 5);
  const held = [...servedBytes(provider).values()];
  assert.ok(held.length > 0 && held.every((b) => !isZero(b)));

  provider.resetForGroup();
  assert.deepEqual(provider.getKeys(), []);
  assert.ok(held.every(isZero), "resetForGroup must zero every dropped array");

  await provider.applyKeys(frameKeys(3, [LOCAL, BOB]), LOCAL);
  const groupOne = [...servedBytes(provider).values()];
  // An install for a DIFFERENT group resets through `#admits`.
  await provider.applyKeys(
    frameKeys(1, [LOCAL, BOB], [LOCAL, BOB], "group-2"),
    LOCAL,
  );
  assert.ok(
    groupOne.every(isZero),
    "the replaced group's arrays must be zeroed",
  );
  for (const bytes of servedBytes(provider).values()) {
    assert.ok(!isZero(bytes));
  }
});

test("raw mode zeroes on its own, not through the base class's private map", async () => {
  // The base class's retained map shares each array, so `#pruneRetainedKeys`
  // zeroes most of them as a side effect — until a LiveKit upgrade renames
  // the field and the prune goes quiet. Stand in for that upgrade (a store
  // that is not a Map, so the prune's accessor finds nothing) and the
  // provider's own replace and reset must still zero everything they drop.
  const provider = rawProvider();
  (provider as unknown as { keyInfoMap: unknown }).keyInfoMap = {
    set() {},
  };
  assert.equal(retainedKeyIds(provider), undefined);

  await rotateThrough(provider, 4, [LOCAL, BOB, CAROL]);
  const at4 = [...servedBytes(provider).values()];
  await provider.applyKeys(frameKeys(5, [LOCAL, BOB]), LOCAL);
  assert.ok(at4.every(isZero), "a replace must zero what it drops");

  const at5 = [...servedBytes(provider).values()];
  assert.ok(at5.every((b) => !isZero(b)));
  provider.resetForGroup();
  assert.ok(at5.every(isZero), "resetForGroup must zero what it drops");
});

test("raw mode keeps the main-thread import as validation: a refused entry posts nothing", async () => {
  // The worker imports the bytes itself, but the page still imports them
  // first, so an install the main thread cannot import is refused before ANY
  // of it reaches the worker — all-or-nothing, exactly as on Chromium.
  let asked = 0;
  const provider = rawProvider(() => {
    asked++;
    return Promise.resolve(true);
  });
  const log = new PostLog().attach(provider);
  await rotateThrough(provider, 5);
  const posted = log.posts.length;
  const askedBefore = asked;
  const before = [...servedBytes(provider)].map(([id, b]) => [id, [...b]]);

  // Epoch 6's remote half imports bob@5, carol@5, bob@6, carol@6 (ours comes
  // after, in the local half); the third is refused.
  const imports = failNthImport(3);
  try {
    await assert.rejects(
      () => provider.applyKeys(frameKeys(6, [LOCAL, BOB, CAROL]), LOCAL),
      /refused/,
    );
  } finally {
    imports.restore();
  }
  assert.equal(log.posts.length, posted, "nothing may reach the worker");
  assert.equal(asked, askedBefore, "no ack wait for an install never posted");
  assert.deepEqual(
    [...servedBytes(provider)].map(([id, b]) => [id, [...b]]),
    before,
    "the replay set, and its bytes, are untouched",
  );
});

test("🔴 the local key's ack wait is registered BEFORE its post, and only the local key's (R13a)", async () => {
  // `waitKeyAck` withdraws any earlier ack for the pair when it registers
  // (indices repeat every 16 epochs). A wait registered after the post — or
  // after any await — can miss the fresh ack or be satisfied by a stale one.
  const events: string[] = [];
  const provider = rawProvider((identity, keyIndex) => {
    events.push(`wait ${identity}-${keyIndex}`);
    return Promise.resolve(true);
  });
  provider.on(KeyProviderEvent.SetKey, (info: KeyInfo) => {
    events.push(`post ${info.participantIdentity}-${info.keyIndex}`);
  });

  await provider.applyKeys(frameKeys(3, [LOCAL, BOB]), LOCAL);
  assert.deepEqual(events, [
    `post ${BOB}-2`,
    `post ${BOB}-3`,
    `wait ${LOCAL}-3`,
    `post ${LOCAL}-3`,
  ]);

  // The Add-grace half installs remotes only: nothing to wait for.
  events.length = 0;
  await provider.applyRemoteKeys(frameKeys(4, [LOCAL, BOB]), LOCAL);
  assert.deepEqual(events, [`post ${BOB}-3`, `post ${BOB}-4`]);
  await provider.applyLocalKey(frameKeys(4, [LOCAL, BOB]), LOCAL);
  assert.deepEqual(events.slice(2), [`wait ${LOCAL}-4`, `post ${LOCAL}-4`]);
});

test(
  "🔴 raw mode claims the local key installed only after the worker acks it",
  { timeout: 2000 },
  async () => {
    const ack = deferred<boolean>();
    const provider = rawProvider(() => ack.promise);
    let installed = false;
    const install = provider
      .applyKeys(frameKeys(3, [LOCAL, BOB]), LOCAL)
      .then(() => {
        installed = true;
      });
    await settle();

    assert.equal(installed, false, "no ack yet, so nothing is installed yet");
    // The key itself is already with the worker and replayable: the ack
    // gates the CLAIM, not the switch.
    assert.deepEqual(
      bytesPosted(new PostLog().replay(provider).at(-1)),
      bytesOf(LOCAL, 3),
    );

    ack.resolve(true);
    await install;
    assert.equal(installed, true);
  },
);

test("🔴 a refused, failed or missing ack throws LocalKeyAckError, with the key still posted", async () => {
  const cases: [string, () => Promise<boolean>][] = [
    ["ok:false", () => Promise.resolve(false)],
    ["a rejected wait", () => Promise.reject(new Error("tracker gone"))],
    [
      "a throwing wait",
      () => {
        throw new Error("tracker gone");
      },
    ],
    ["a truthy non-boolean", () => Promise.resolve(1 as unknown as boolean)],
  ];
  for (const [label, wait] of cases) {
    const provider = rawProvider(wait);
    const log = new PostLog().attach(provider);
    let caught: unknown;
    await provider.applyKeys(frameKeys(3, [LOCAL, BOB]), LOCAL).catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof LocalKeyAckError, `${label}: LocalKeyAckError`);
    assert.equal(caught.groupId, GROUP, label);
    assert.equal(caught.epoch, 3, label);
    assert.equal(caught.keyIndex, 3, label);
    // No key material and no identity in what the session logs.
    const text = `${caught.message} ${String(caught.stack)}`;
    assert.ok(!text.includes(key(LOCAL, 3).frame_key_b64), label);
    assert.ok(!text.includes(LOCAL), label);
    // The Remove-driven switch still reached the worker, and the replay set
    // mirrors what was SENT.
    assert.deepEqual(bytesPosted(log.posts.at(-1)), bytesOf(LOCAL, 3), label);
    assert.deepEqual(
      bytesPosted(new PostLog().replay(provider).at(-1)),
      bytesOf(LOCAL, 3),
      label,
    );
  }

  // The deferred (Add-grace) local install is gated the same way.
  const provider = rawProvider(() => Promise.resolve(false));
  await provider.applyRemoteKeys(frameKeys(5, [LOCAL, BOB]), LOCAL);
  await assert.rejects(
    () => provider.applyLocalKey(frameKeys(5, [LOCAL, BOB]), LOCAL),
    LocalKeyAckError,
  );
});

test(
  "composes with the real WorkerAckTracker, unbound, as state.tsx wires it",
  { timeout: 5000 },
  async () => {
    const tracker = createWorkerAckTracker({
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
      timeoutMs: 200,
    });
    // Handed in UNBOUND, the way `awaitKeyAck: tracker.waitKeyAck` passes it.
    const provider = new MlsKeyProvider({
      rawKeyBytes: true,
      awaitKeyAck: tracker.waitKeyAck,
    });
    let answer: boolean | undefined = true;
    provider.on(KeyProviderEvent.SetKey, (info: KeyInfo) => {
      if (answer === undefined) return; // a worker that never answers
      const ok = answer;
      // The worker's ack is a separate message event: a later macrotask.
      setImmediate(() =>
        tracker.onMessage({
          kind: "slogaSetKeyAck",
          data: {
            identity: info.participantIdentity,
            keyIndex: info.keyIndex,
            ok,
          },
        }),
      );
    });

    await provider.applyKeys(frameKeys(3, [LOCAL, BOB]), LOCAL);
    assert.equal(tracker.keyAcked(LOCAL, 3), true);

    // Epoch 19 reuses index 3. The worker refuses it; epoch 3's ok ack for
    // the same slot must not stand in for it.
    answer = false;
    await assert.rejects(
      () => provider.applyKeys(frameKeys(19, [LOCAL, BOB]), LOCAL),
      LocalKeyAckError,
    );

    // A worker that never answers times out into the same loud failure.
    answer = undefined;
    await assert.rejects(
      () => provider.applyKeys(frameKeys(20, [LOCAL, BOB]), LOCAL),
      LocalKeyAckError,
    );
  },
);

// ---------------------------------------------------------------------------
// D15: livekit's ratchet path stays unreachable
//
// The worker's reply to a ratchet request carries a `CryptoKey` back to the
// page, which WebKit may fail to clone, and MLS epochs are the only rotation
// (`ratchetWindowSize: 0`, asserted above). So no production code under
// `components/` may call the provider's ratchet method, post the request kind,
// emit the event that drives it, or call the manager method that posts it.
// ---------------------------------------------------------------------------

const RATCHET_CALL =
  /\bratchetKey\b|\bratchetRequest\b|\bRatchetRequest\b|\bpostRatchetRequest\b/;

/**
 * Lines that reach the ratchet path. Comment lines are skipped (a doc line
 * naming the API is not a call; a false red there would only be noise), and
 * the CALLER skips specs: `livekitPatchHunks.test.ts` drives the worker's
 * ratchet handler on purpose, to pin the patched reply.
 */
function ratchetHits(files: { path: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((line, index) => {
      const code = line.trim();
      if (
        code.startsWith("//") ||
        code.startsWith("*") ||
        code.startsWith("/*")
      )
        return;
      if (RATCHET_CALL.test(line)) hits.push(`${path}:${index + 1}`);
    });
  }
  return hits;
}

/** Every non-spec source file under `root` (catalogs and node_modules out). */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === "catalogs") continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) &&
      !/\.test\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)
    ) {
      out.push(path);
    }
  }
  return out;
}

test("D15 control: the scan flags every shape of ratchet call, and only those", () => {
  // The known-bad half, in memory: each line below is a way production code
  // could reach the ratchet path, and the scan must flag every one of them.
  const bad = [
    "provider.ratchetKey(identity, 0);",
    'worker.postMessage({ kind: "ratchetRequest", data: {} });',
    "keyProvider.emit(KeyProviderEvent.RatchetRequest, id, 0);",
    "manager.postRatchetRequest(id, 0);",
    "  const r = p.ratchetKey; r(); // trailing comment",
  ];
  assert.deepEqual(
    ratchetHits(bad.map((text, i) => ({ path: `bad${i}.ts`, text }))),
    bad.map((_, i) => `bad${i}.ts:1`),
  );
  // …and what it must leave alone.
  const fine = [
    "// never call ratchetKey here",
    "/** nor post ratchetRequest */",
    " * a doc line about RatchetRequest",
    "super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });",
    "provider.on(KeyProviderEvent.KeyRatcheted, noop);",
  ].join("\n");
  assert.deepEqual(ratchetHits([{ path: "fine.ts", text: fine }]), []);
});

test("🔴 D15: no code under components/ reaches livekit's ratchet path", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = sourceFiles(root);
  // Prove the walk really covered the tree it claims to, not an empty dir.
  assert.ok(files.length > 100, `only ${files.length} files scanned`);
  assert.ok(files.some((f) => f.endsWith(join("rtc", "state.tsx"))));
  assert.ok(files.some((f) => f.endsWith(join("rtc", "mlsCallKeys.ts"))));
  assert.ok(!files.some((f) => /\.test\./.test(f)));

  const hits = ratchetHits(
    files.map((path) => ({ path, text: readFileSync(path, "utf8") })),
  );
  assert.deepEqual(hits, [], "a ratchet call site exists under components/");
});
