/**
 * Removes cached "model files" that are really the app's HTML page.
 *
 * transformers.js keeps every model file it downloads in the browser's Cache
 * Storage (the `transformers-cache` cache), and on the next load it reads that
 * cache BEFORE it goes to the network. It stores any response with status
 * 200, without looking at what the response is.
 *
 * That turned one server mistake into a permanent per-browser failure. From
 * the 2026-08-24 move to the new production host until the `/models/` route
 * was restored, a request for `/models/whisper-tiny/config.json` fell through
 * to the single-page-app fallback and came back as `index.html`, 200,
 * text/html. transformers.js cached that page under the config's URL and then
 * failed to parse it as JSON. Fixing the server does not help such a browser:
 * the next press of Transcribe reads the cached page again and fails the same
 * way, forever, until the cache is cleared by hand.
 *
 * So before every load, the worker drops any cached entry under the model
 * path whose content type is HTML. No real model file is HTML (they are JSON,
 * plain text and binary), so this cannot delete anything good. It only costs a
 * cache lookup per stored file, once per load.
 */

/** The Cache Storage name transformers.js uses (its `caches.open` call). */
export const MODEL_CACHE_NAME = "transformers-cache";

/** The parts of `CacheStorage` this needs, so a spec can pass a fake. */
export type ModelCacheStorage = Pick<CacheStorage, "has" | "open">;

/**
 * Delete cached entries under `pathPrefix` that hold an HTML page.
 *
 * Resolves to the number of entries removed. Never rejects: a cache that
 * cannot be read is the same as an empty one here, and the model load that
 * follows must not fail because of this cleanup.
 */
export async function purgeHtmlFromModelCache(
  storage: ModelCacheStorage | undefined,
  pathPrefix: string,
): Promise<number> {
  if (!storage) return 0;
  let removed = 0;
  try {
    // `has` first, so a browser that never transcribed does not get an
    // empty cache created just by checking.
    if (!(await storage.has(MODEL_CACHE_NAME))) return 0;
    const cache = await storage.open(MODEL_CACHE_NAME);
    for (const request of await cache.keys()) {
      if (!new URL(request.url).pathname.startsWith(pathPrefix)) continue;
      const response = await cache.match(request);
      const type = response?.headers.get("content-type") ?? "";
      if (/^\s*text\/html\b/i.test(type) && (await cache.delete(request))) {
        removed += 1;
      }
    }
  } catch {
    // See the doc comment: cleanup is best effort.
  }
  return removed;
}
