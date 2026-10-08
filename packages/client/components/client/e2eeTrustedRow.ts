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
 */

/**
 * Adopts the decrypted row `id` into `collection`. When it is not
 * `alreadyTrusted` and an object is cached under `id`, `evict(id)` runs
 * exactly once, BEFORE `getOrCreate`. Returns `getOrCreate`'s result.
 */
export function adoptTrustedRow<T>(
  collection: {
    has(id: string): boolean;
    getOrCreate(id: string, data: never, isNew: boolean): T;
  },
  id: string,
  data: unknown,
  isNew: boolean,
  alreadyTrusted: boolean,
  evict: (id: string) => void,
): T {
  if (!alreadyTrusted && collection.has(id)) {
    evict(id);
  }
  return collection.getOrCreate(id, data as never, isNew);
}
