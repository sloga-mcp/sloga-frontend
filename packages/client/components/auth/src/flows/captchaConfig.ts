/**
 * Whether the API server wants a captcha, and which hCaptcha sitekey to use.
 *
 * The server is the source of truth: its root document (`GET {api}/`)
 * reports `features.captcha.enabled` and the public sitekey in
 * `features.captcha.key`, and it rejects a captcha-less request whenever the
 * feature is on. The build-time `VITE_HCAPTCHA_SITEKEY` is only a fallback for
 * servers that do not ask for one.
 *
 * Pure on purpose, and deliberately free of app imports, so `node --test` can
 * load it (`captchaConfig.test.ts`). In particular it must not import
 * `CONFIGURATION`: `env.ts` reads `import.meta.env`, which Node does not have.
 * Callers pass `CONFIGURATION.DEFAULT_API_URL` and
 * `CONFIGURATION.HCAPTCHA_SITEKEY` in.
 */

/** The captcha half of the server's root document. */
export interface ServerCaptcha {
  enabled: boolean;
  key?: string;
}

/**
 * Successful lookups, and lookups still in flight, keyed by the API URL
 * without its trailing slashes. A failed lookup removes its own entry, so the
 * next call asks the server again.
 */
const cache = new Map<string, Promise<ServerCaptcha>>();

/**
 * Fetch and parse the root document once.
 *
 * Returns `null` on any failure (network error, non-2xx, a body that is not a
 * JSON object) so the caller can tell a failure, which is not cached, from a
 * server that really has captcha turned off, which is.
 */
async function fetchServerCaptcha(
  base: string,
  fetchImpl: typeof fetch,
): Promise<ServerCaptcha | null> {
  try {
    const response = await fetchImpl(`${base}/`);
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }

    const captcha = (
      body as { features?: { captcha?: { enabled?: unknown; key?: unknown } } }
    ).features?.captcha;
    const key = captcha?.key;

    return {
      enabled: !!captcha?.enabled,
      key: typeof key === "string" && key ? key : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Ask the server whether it requires a captcha.
 *
 * Concurrent callers share one request. A successful answer is remembered for
 * the life of the page; a failure resolves to `{ enabled: false }` (today's
 * behavior, and the server still refuses a request it wanted a captcha for)
 * and is not remembered, so the next call retries. Never rejects.
 */
export async function getServerCaptcha(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerCaptcha> {
  const base = apiUrl.replace(/\/+$/, "");

  const cached = cache.get(base);
  if (cached) return cached;

  const pending: Promise<ServerCaptcha> = fetchServerCaptcha(
    base,
    fetchImpl,
  ).then((result) => {
    if (result) return result;

    // Only drop our own entry: a reset during the request may have let a
    // newer lookup take the slot.
    if (cache.get(base) === pending) cache.delete(base);
    return { enabled: false };
  });

  cache.set(base, pending);
  return pending;
}

/**
 * Pick the sitekey for the hCaptcha widget.
 *
 * When the server asks for a captcha its key wins, and may be `undefined`:
 * the caller must treat "enabled without a key" as captcha required but
 * unavailable, never as a reason to submit without a token. When the server
 * does not ask, the build-time key (if any) is used.
 */
export function resolveSitekey(
  server: ServerCaptcha,
  buildTimeKey: string | undefined,
): string | undefined {
  if (server.enabled) return server.key;
  return buildTimeKey || undefined;
}

/**
 * Forget every remembered lookup.
 *
 * Test-only: specs call this between cases so each one starts with an empty
 * cache. App code has no reason to call it.
 */
export function __resetServerCaptchaCache(): void {
  cache.clear();
}
