// Specs for the frame-key provider's REPLAY surface (slice 6.3 / plan §7.2) —
// run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/mlsCallKeys.test.ts
//
// These drive the REAL `MlsKeyProvider` against the REAL `BaseKeyProvider`
// (livekit-client 2.15.13 instantiates headless, and Node's WebCrypto imports
// raw HKDF material), so the base class's storage order is under test here,
// not a stand-in for it.
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
//   `E2EEManager` replays `getKeys()` into the worker on the `initAck`, on
//   every `enable` ack (posted for every remote `TrackPublished` and for every
//   remote publication on each `ConnectionState.Connected`) and on every
//   `SignalConnected`. Each replayed `setKey` moves the recipient's
//   `currentKeyIndex`, and the encoder publishes under
//   `cryptoKeyRing[currentKeyIndex]`.
//
//   So at epoch >= 16, one peer unmuting was enough to drop this device back
//   onto epoch 15's key: a member removed at epoch 16-30 still holds it and
//   could read the media (locked decision 7), while a member added after epoch
//   15 raises `MissingKey ... at index 15`. The loud side is the SAFE one; the
//   removed member's side is silent.
//
// The fix is the `getKeys()` override, so every assertion below is about what
// a REPLAY does — never about what a fresh install does.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeyInfo } from "livekit-client";
import { KeyProviderEvent } from "livekit-client";

import { MlsKeyProvider, orderForInstall } from "./mlsCallKeys.ts";

const LOCAL = "alice:dev-a";
const BOB = "bob:dev-b";
const CAROL = "carol:dev-c";

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
function frameKeys(epoch: number, roster: string[], previousRoster = roster) {
  return {
    group_id: "group-1",
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
    labels,
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
    of(key: CryptoKey | undefined) {
      return key === undefined ? undefined : labels.get(key);
    },
  };
}

// ---------------------------------------------------------------------------
// A faithful model of the half of livekit's worker this defect lives in
// ---------------------------------------------------------------------------

/**
 * `ParticipantKeyHandler` (livekit-client e2ee/worker/ParticipantKeyHandler.ts):
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
 */
class FakeKeyHandler {
  readonly ring: (CryptoKey | undefined)[] = new Array(KEYRING_SIZE).fill(
    undefined,
  );

  currentKeyIndex = 0;

  setKey(key: CryptoKey, keyIndex = 0) {
    const newIndex =
      keyIndex >= 0 ? keyIndex % KEYRING_SIZE : this.currentKeyIndex;
    this.ring[newIndex] = key;
    this.currentKeyIndex = newIndex;
  }

  /** The key the encoder would use for the next frame. */
  sending(): CryptoKey | undefined {
    return this.ring[this.currentKeyIndex];
  }
}

/**
 * `E2EEManager`'s replay: on `initAck` / every `enable` ack / every
 * `SignalConnected` it walks `keyProvider.getKeys()` and `postKey`s each entry
 * (E2eeManager.ts:151-153, :159-161, :257-259), which the worker routes to
 * `getParticipantKeyHandler(identity).setKey(key, keyIndex)`
 * (e2ee.worker.ts:131-142).
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

  replay(provider: MlsKeyProvider): void {
    for (const info of provider.getKeys()) {
      // `sharedKey:false`, so the base class rejects a keyless identity —
      // an entry without one would be a bug in the provider, not the worker.
      assert.ok(
        info.participantIdentity,
        "every replayed KeyInfo must carry an identity",
      );
      this.handler(info.participantIdentity).setKey(info.key, info.keyIndex);
    }
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

  const replayed = provider
    .getKeys()
    .map((info) => `${info.participantIdentity}-${info.keyIndex}`);
  const expected = orderForInstall(frameKeys(20, [LOCAL, BOB]), LOCAL).map(
    (entry) => `${entry.livekit_identity}-${entry.key_index}`,
  );

  // previous(remote) + current(remote) + current(local) — three entries, not
  // the 32 the base class had accumulated by epoch 20.
  assert.deepEqual(replayed, expected);
  assert.equal(replayed.length, 3);
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

  // …and the deferred local install completes the switch.
  await tag.during(next, () => provider.applyLocalKey(next, LOCAL));
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e20`);
  assert.equal(worker.handler(LOCAL).currentKeyIndex, 20 % KEYRING_SIZE);
});

test("an epoch that carries no local key does not blank the replay's send key", async () => {
  const provider = new MlsKeyProvider();
  const tag = await rotateThrough(provider, 17);

  // Anomalous egress: native returned an epoch with no entry for us. The
  // worker is still holding epoch 17's key, so the replay has to say so —
  // blanking it would hand LiveKit an empty local set and leave the encoder's
  // `currentKeyIndex` wherever the last remote entry put it.
  const headless = frameKeys(18, [BOB], [LOCAL, BOB]);
  await tag.during(headless, () => provider.applyLocalKey(headless, LOCAL));

  const worker = new FakeWorker();
  worker.replay(provider);
  assert.equal(tag.of(worker.handler(LOCAL).sending()), `${LOCAL}@e17`);
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
