import isEqual from "lodash.isequal";
import { batch } from "solid-js";

import { ReactiveSet } from "@solid-primitives/set";
import { Client } from "stoat.js";

import { State } from "..";

import { AbstractStore } from ".";
import { TypeFriendGroups } from "./FriendGroups";
import { TypeFriends } from "./Friends";
import { TypeNotificationOptions } from "./NotificationOptions";
import { TypeOrdering } from "./Ordering";
import { TypeReleaseNotes } from "./ReleaseNotes";
import { TypeTheme } from "./Theme";

type SynchronisedStores =
  | "ordering"
  | "notifications"
  | "release-notes"
  | "friends"
  | "friend-groups"
  | "theme";

const STORE_KEYS: SynchronisedStores[] = [
  "ordering",
  "notifications",
  "release-notes",
  "friends",
  "friend-groups",
  "theme",
];

/**
 * Theme fields that stay on the device they were set on
 *
 * Text, spacing and avatar sizes suit the screen they were picked on, so a
 * phone should not take a desktop's, and blur is turned off for the machine
 * that is too slow for it. They are left out of the upload, kept from this
 * device when a remote copy is adopted, and editing one does not queue an
 * upload. The appearance menu says so; keep its wording in step.
 */
export const DEVICE_LOCAL_THEME_FIELDS = [
  "blur",
  "messageSize",
  "messageGroupSpacing",
  "messageAvatarSize",
] as const satisfies readonly (keyof TypeTheme)[];

/**
 * Keys this device kept to itself before they synchronised
 *
 * An account with no copy yet gets this device's data on the first sync,
 * unless it is still the default, instead of waiting for the next edit.
 * Without that, colors picked before the update would never leave the
 * device they were picked on.
 */
const SEED_IF_ABSENT: SynchronisedStores[] = ["theme"];

/**
 * The part of a store's data that is uploaded for its key
 * @param key Store key
 * @param data The store's data
 * @returns Data to upload
 */
export function syncedData(key: string, data: unknown): unknown {
  if (key !== "theme") return data;

  const synced = { ...(data as Record<string, unknown>) };
  for (const field of DEVICE_LOCAL_THEME_FIELDS) delete synced[field];
  return synced;
}

/**
 * The part of a key's data that decides whether it is worth seeding an
 * account with (`SEED_IF_ABSENT`): the synced data, less what the active
 * choice ignores
 *
 * Installs from before the Sloga preset still carry the old Material You
 * accent (#FF5733), which nobody chose (see `TypeTheme.slogaAccent`). Under
 * the Sloga preset no Material You control shows, and counting them would
 * seed the account from an untouched install ahead of a customized device.
 * @param key Store key
 * @param data The store's data
 * @returns Data to compare against the default
 */
export function seedView(key: string, data: unknown): unknown {
  const synced = syncedData(key, data);
  if (key !== "theme") return synced;

  // a copy of its own: the deletes below must never reach the store
  const theme = { ...(synced as Partial<TypeTheme>) };
  if (theme.preset === "stoat") {
    delete theme.m3Accent;
    delete theme.m3Contrast;
    delete theme.m3Variant;
  }
  return theme;
}

/**
 * Whether a remote copy of a key is in the format this client uploads
 *
 * Revite synced a "theme" key of its own, in a different shape, and clean()
 * would turn one into the default theme. Every client that uploads this
 * format writes `presetMigrated` (`Theme.clean()` always sets it).
 * @param key Store key
 * @param remote Parsed remote data
 * @returns Whether to merge it
 */
export function isOwnFormat(key: string, remote: unknown): boolean {
  if (key !== "theme") return true;
  return (
    typeof remote === "object" &&
    remote !== null &&
    (remote as Partial<TypeTheme>).presetMigrated === true
  );
}

export interface TypeSynchronisation {
  revision: Record<SynchronisedStores, number>;

  /**
   * Id of the account the synchronised stores and revisions belong to
   *
   * Absent on a device that has not signed in since this field was added.
   */
  owner?: string;
}

/**
 * Longest owner id clean() keeps (user ids are 26-character ULIDs)
 */
const OWNER_MAX_LENGTH = 64;

/**
 * What merging a remote copy of a key should do on this device
 *
 * - "adopt": hydrate the store with the remote data and take its revision
 * - "touch": local data is newer and differs, so write it back out
 * - "noop": nothing to do
 */
export type SyncMergeDecision = "adopt" | "touch" | "noop";

/**
 * Decide how to merge a remote copy of a key
 * @param remoteTs Remote revision
 * @param localTs This device's revision for the key, if it has one
 * @param sameData Whether the local data equals the remote data
 * @returns Decision
 */
export function syncMergeDecision(
  remoteTs: number,
  localTs: number | undefined,
  sameData: () => boolean,
): SyncMergeDecision {
  // No local revision means this device has never synced the key: a fresh
  // install, or a client update that added the key while the revision map on
  // disk predates it (clean() drops absent and zero revisions). Its data is
  // the store default, never an edit, since an edit always sets a revision.
  // Comparing timestamps here used to fall through to "touch", which pushed
  // the empty default out with a newer revision and wiped every device.
  if (!localTs) return "adopt";
  if (remoteTs > localTs) return "adopt";
  if (remoteTs !== localTs && !sameData()) return "touch";
  return "noop";
}

/**
 * Synchronisation orchestration
 */
export class Sync extends AbstractStore<"sync", TypeSynchronisation> {
  /**
   * Block sync for remote updates
   */
  #blockSync: Set<SynchronisedStores>;

  /**
   * Keys that need to be synced out
   */
  #syncQueue: ReactiveSet<SynchronisedStores>;

  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "sync");
    this.#blockSync = new Set();
    this.#syncQueue = new ReactiveSet();
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {}

  /**
   * Generate default values
   */
  default(): TypeSynchronisation {
    return {
      revision: {
        ordering: 0,
        notifications: 0,
        "release-notes": 0,
        friends: 0,
        "friend-groups": 0,
        theme: 0,
      },
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeSynchronisation>): TypeSynchronisation {
    const clean: TypeSynchronisation = {
      revision: Object.keys(input.revision ?? {})
        .filter((key) => STORE_KEYS.includes(key as SynchronisedStores))
        .filter((key) => input.revision?.[key as SynchronisedStores])
        .reduce(
          (d, k) => ({ ...d, [k]: input.revision?.[k as SynchronisedStores] }),
          {} as TypeSynchronisation["revision"],
        ),
    };

    // Left out rather than set to undefined when invalid, so a disk copy
    // without an owner stays equal to its cleaned form
    if (
      typeof input.owner === "string" &&
      input.owner.length > 0 &&
      input.owner.length <= OWNER_MAX_LENGTH
    ) {
      clean.owner = input.owner;
    }

    return clean;
  }

  /**
   * Id of the account the synchronised stores belong to, if known
   */
  get owner(): string | undefined {
    return this.get().owner;
  }

  /**
   * Record which account the synchronised stores belong to
   *
   * Only `ensureAccountOwner` (`../accountReset.ts`) should call this: it
   * resets the stores first when the account changes.
   * @param userId User id
   */
  setOwner(userId: string) {
    this.set("owner", userId);
  }

  /**
   * Synchronise data into store
   * @param client Client
   * @param isCurrent Whether the session `client` belongs to is still the
   *   active one; read once the response arrives
   */
  async initialSync(client: Client, isCurrent: () => boolean = () => true) {
    const owner = this.owner;
    const response = await client.api.post("/sync/settings/fetch", {
      keys: STORE_KEYS,
    });

    // A response that lands after its session ended carries that session's
    // account data. Merged now it would be adopted into whichever account
    // signed in since (the owner check), or sit in the stores after sign-out.
    if (!isCurrent() || this.owner !== owner) {
      if (import.meta.env.DEV)
        console.info("[sync] dropped a settings fetch from an ended session");
      return;
    }

    const merged = new Set<string>();
    for (const key in response) {
      const [ts, data] = response[key];
      if (this.merge(ts, key as SynchronisedStores, data)) merged.add(key);
    }

    // the account has no usable copy of a key this device kept to itself
    // before it synchronised: upload this device's, if it has one
    for (const key of SEED_IF_ABSENT) {
      if (merged.has(key)) continue;

      const ours = seedView(key, this.state.get(key));
      const fallback = seedView(key, this.state[key].default());
      if (!isEqual(ours, fallback)) this.touch(key);
    }
  }

  /**
   * Send data to remote
   * @param client Client
   */
  async save(client: Client) {
    // find all keys for sync
    const keys = this.#syncQueue.keys().toArray();

    // due to API constraints, merge ts down
    const ts = +new Date();

    // generate payload
    const payload = keys.reduce(
      (d, k) => ({
        ...d,
        [k]: JSON.stringify(syncedData(k, this.state.get(k))),
      }),
      {
        timestamp: ts,
      },
    );

    // apply new ts and remove all of the keys
    batch(() =>
      keys.forEach((key) => {
        this.set("revision", key, ts);
        this.#syncQueue.delete(key);
      }),
    );

    // send data to the server
    await client.api.post("/sync/settings/set", payload);
  }

  /**
   * Get revision for key
   * @param key Key
   * @returns Revision timestamp
   */
  private ts(key: SynchronisedStores) {
    return this.get().revision[key];
  }

  /**
   * Update timestamp for key
   * @param key Key
   */
  touch(key: SynchronisedStores) {
    if (this.#blockSync.has(key)) {
      this.#blockSync.delete(key);
      return;
    }

    this.set("revision", key, +new Date());
    this.#syncQueue.add(key);
  }

  /**
   * Update timestamp for key
   * @param key Key
   * @param field Field of the store being written, when the write names one
   */
  touchIfSyncable(key: string, field?: unknown) {
    if (
      key === "theme" &&
      (DEVICE_LOCAL_THEME_FIELDS as readonly unknown[]).includes(field)
    ) {
      return;
    }

    if (STORE_KEYS.includes(key as SynchronisedStores)) {
      this.touch(key as SynchronisedStores);
    }
  }

  /**
   * Write to a key without stamping a revision or queuing an upload
   *
   * For changes made with no account signed in, such as the light/dark
   * toggle on the sign-in page: a fresh revision there would make this
   * device's whole copy beat the account's own on the first sync.
   * @param key Key the write goes to
   * @param write The write
   */
  untracked(key: SynchronisedStores, write: () => void) {
    this.#blockSync.add(key);
    try {
      write();
    } finally {
      // spent by the write's touch; dropped anyway, as in reset()
      this.#blockSync.delete(key);
    }
  }

  /**
   * Drop keys from the upload queue without sending them
   *
   * A queued key is uploaded by whichever session is signed in when
   * SyncWorker next saves, so a key queued as one account signs out would
   * otherwise go to the next account to sign in.
   * @param keys Keys to drop; other queued keys stay queued
   */
  forget(keys: SynchronisedStores[]) {
    batch(() => keys.forEach((key) => this.#syncQueue.delete(key)));
  }

  /**
   * Put keys back as a device that has never synced them: default data, no
   * revision, nothing queued
   *
   * Nothing is uploaded, so another device's copy is untouched, and with no
   * revision the next remote copy is adopted as is (`syncMergeDecision`).
   * @param keys Keys to reset
   */
  reset(keys: SynchronisedStores[]) {
    for (const key of keys) {
      this.#syncQueue.delete(key);

      // State.write() touches the key, which would stamp a new revision and
      // queue the default for upload; the block swallows that one touch
      this.#blockSync.add(key);
      this.state.set(key, this.state[key].default());
      // spent by the write above; dropped anyway, so a writer that never
      // touched cannot leave it to swallow the next real edit
      this.#blockSync.delete(key);

      // undefined deletes the key; the setter's types don't model deletion
      this.set("revision", key, undefined as unknown as number);
    }
  }

  /**
   * Merge data
   * @param ts Timestamp
   * @param key Store key
   * @param data Data to merge
   * @returns Whether the remote copy was in this client's format; one that
   *   was not is ignored
   */
  merge(ts: number, key: SynchronisedStores, data: string): boolean {
    if (import.meta.env.DEV)
      console.info(`[sync] merge ${key} at ${ts} with`, data);

    const remote = JSON.parse(data);
    if (!isOwnFormat(key, remote)) {
      if (import.meta.env.DEV)
        console.info(`[sync] ignored a ${key} copy in another format`);
      return false;
    }

    // the uploaded theme has no device-local fields; this device keeps its own
    if (key === "theme") {
      const local = this.state.get(key);
      for (const field of DEVICE_LOCAL_THEME_FIELDS) {
        remote[field] = local[field];
      }
    }

    const parsed = this.state[key].clean(remote);
    const decision = syncMergeDecision(ts, this.ts(key), () =>
      isEqual(
        this.state.get(key),
        parsed as TypeOrdering &
          TypeNotificationOptions &
          TypeReleaseNotes &
          TypeFriends &
          TypeFriendGroups &
          TypeTheme,
      ),
    );

    if (decision === "adopt") {
      // remote is newer, or this device has nothing of its own yet: hydrate
      // the store with it, without echoing the write back to remote
      this.set("revision", key, ts);
      this.#blockSync.add(key);
      this.state.set(key, parsed);
    } else if (decision === "touch") {
      // remote is older and our data differs, so synchronise it to remote
      this.touch(key);
    }

    return true;
  }

  /**
   * Consume client events
   * @param event Update event
   */
  consumeEvent(event: Record<string, [number, string]>) {
    for (const key in event) {
      if (STORE_KEYS.includes(key as SynchronisedStores)) {
        const [ts, data] = event[key];
        this.merge(ts, key as SynchronisedStores, data);
      }
    }
  }

  /**
   * Whether there are items in queue to sync
   */
  get shouldSync() {
    return this.#syncQueue.values().next().done === false;
  }
}
