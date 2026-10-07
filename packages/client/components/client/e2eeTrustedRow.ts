/**
 * Trusted-row adoption for the E2EE inject path (`#inject` in `e2ee.ts`) -
 * pure and dependency-free so `node --test` can load it (the house no-vitest
 * split).
 *
 * Why this exists: an inbound decrypted row reuses the server's envelope id,
 * and `MessageCollection.getOrCreate` hands back an already-cached object
 * unchanged. A compromised server can push a forged `Message` event with that
 * `_id` BEFORE decrypt finishes; it lands in the cache, `#inject` reused it
 * and marked it trusted, so forged plaintext rendered under the lock. A row
 * that is not yet trusted therefore evicts any cached object first, so the
 * decrypted shape is what gets created. A row re-injected from history that
 * is ALREADY trusted is that same trusted object and is never evicted.
 *
 * The `live` rule: `getOrCreate` is told the row is new only when the call is
 * live AND it will actually create the object (nothing is cached under the id
 * once any eviction has run). That matches `MessageCollection.getOrCreate`,
 * which only emits `messageCreate` when it creates. So a row that replaces an
 * evicted untrusted object still appears live, while a trusted object that is
 * already cached is never announced a second time.
 */

/**
 * Adopts the decrypted row `id` into `collection`. When it is not
 * `alreadyTrusted` and an object is cached under `id`, `evict(id)` runs
 * exactly once, BEFORE `getOrCreate`. `getOrCreate` then receives
 * `isNew = live && !collection.has(id)`. Returns `getOrCreate`'s result.
 */
export function adoptTrustedRow<T>(
  collection: {
    has(id: string): boolean;
    getOrCreate(id: string, data: never, isNew: boolean): T;
  },
  id: string,
  data: unknown,
  live: boolean,
  alreadyTrusted: boolean,
  evict: (id: string) => void,
): T {
  if (!alreadyTrusted && collection.has(id)) {
    evict(id);
  }
  const isNew = live && !collection.has(id);
  return collection.getOrCreate(id, data as never, isNew);
}
