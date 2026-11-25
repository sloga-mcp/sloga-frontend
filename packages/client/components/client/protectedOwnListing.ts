/**
 * D18: the bridge's cache of this user's COMPLETE signed listing (the
 * protected-text port's `ownDeviceListing`), out of `e2ee.ts` so its rule
 * is spec'd. Cached for 60 s and single-flight (the manager asks before
 * every `_process`). A failed refresh falls back to the last listing.
 *
 * F-R8: a listing cached before a new own device registered cannot pin
 * it. So a `force` request (a pin native asked for), or one whose `want`
 * the cached listing does not list, fetches afresh: it never takes the
 * cache, nor a flight whose fetch began before it was asked. A flight's
 * fetch begins a microtask after it is started, so such requests made in
 * the same tick share one fetch (N channels refusing one commit), later
 * requests share it too, and its answer refreshes the cache. When that
 * fetch fails, the last listing it falls back to is marked `stale`: it
 * answers nothing the request asked for.
 */

/** How long a fetched listing is served without asking again. */
export const OWN_LISTING_CACHE_MS = 60_000;

/** What a caller of `ownDeviceListing` asks for. */
export interface OwnListingRequest {
  /** A fresh listing: never the cache or an earlier fetch. */
  force?: boolean;
  /** Device ids the caller needs listed; a cache missing one is refetched. */
  want?: readonly string[];
}

export interface OwnListing {
  hash: string;
  listing: unknown[];
}

/** A fetched listing and when it was fetched (the manager reads `at`). */
export interface OwnListingEntry extends OwnListing {
  at: number;
  /** The fallback of a `force`/`want` request whose fetch failed. */
  stale?: true;
}

interface Flight {
  promise: Promise<OwnListingEntry>;
  /** Its fetch began: a later `force`/`want` request may not share it. */
  begun: boolean;
}

/** Whether every `want` id has a row (`GET /e2ee/devices/{self}` rows). */
function listsAll(
  entry: OwnListingEntry | null,
  want: readonly string[] | undefined,
): boolean {
  if (!want?.length) return true;
  const ids = new Set<string>();
  for (const row of entry?.listing ?? []) {
    const id = (row as { device_id?: unknown } | null)?.device_id;
    if (typeof id === "string") ids.add(id);
  }
  return want.every((id) => ids.has(id));
}

export class OwnListingCache {
  #entry: OwnListingEntry | null = null;
  /** Start order of the cached entry's flight (an older one never wins). */
  #entrySeq = 0;
  #flight: Flight | null = null;
  #seq = 0;
  readonly #now: () => number;
  readonly #life: () => unknown;

  /**
   * `life`: the owner's current lifetime; a flight that settles under
   * another one (a dispose mid-flight) is not cached.
   */
  constructor(now: () => number, life: () => unknown) {
    this.#now = now;
    this.#life = life;
  }

  /** Drops the cache and the flight (the owner's dispose). */
  clear(): void {
    this.#entry = null;
    this.#entrySeq = 0;
    this.#flight = null;
  }

  get(
    load: () => Promise<OwnListing>,
    request: OwnListingRequest = {},
  ): Promise<OwnListingEntry> {
    const cached = this.#entry;
    const fresh = request.force === true || !listsAll(cached, request.want);
    if (!fresh && cached && this.#now() - cached.at < OWN_LISTING_CACHE_MS) {
      return Promise.resolve(cached);
    }
    const shared = this.#flight;
    const flight =
      shared && (!fresh || !shared.begun) ? shared : this.#start(load);
    return flight.promise.catch((error: unknown) => {
      if (!cached) throw error;
      return fresh ? { ...cached, stale: true } : cached;
    });
  }

  #start(load: () => Promise<OwnListing>): Flight {
    const life = this.#life();
    const seq = ++this.#seq;
    const run = async (): Promise<OwnListingEntry> => {
      // Requests made before this microtask share the fetch.
      await Promise.resolve();
      flight.begun = true;
      const { hash, listing } = await load();
      const entry = { hash, listing, at: this.#now() };
      if (this.#life() === life && seq > this.#entrySeq) {
        this.#entry = entry;
        this.#entrySeq = seq;
      }
      return entry;
    };
    const flight: Flight = {
      promise: run().finally(() => {
        if (this.#flight === flight) this.#flight = null;
      }),
      begun: false,
    };
    this.#flight = flight;
    return flight;
  }
}
