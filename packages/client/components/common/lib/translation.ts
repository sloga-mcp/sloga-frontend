/**
 * Message translation via the public Google Translate endpoint.
 *
 * Text is sent to Google when translation is enabled, so callers must never
 * pass E2EE-decrypted content here.
 *
 * ## The transport assumes the endpoint is hostile, because it is
 *
 * `client=gtx` is the free, undocumented endpoint, and its failure mode is
 * rate limiting. The first version had no timeout, no concurrency cap and no
 * memory of having been refused — so a live call's captions (one request per
 * finalized utterance per participant, interims debounced at 450 ms) would
 * pile requests into a 429 wall one at a time, each waiting the browser's
 * full patience before silently falling back. Reported from the field
 * 2026-08-10 as "very slow" and "sometimes just doesn't work". Hence:
 *
 * - **A request gets 7 seconds, then it is aborted.** A caption translated
 *   later than that is describing a conversation that has moved on.
 * - **At most two requests are in flight**; the rest queue FIFO. Bursts are
 *   what provoke the rate limiter in the first place.
 * - **A 429 or 403 opens a 30-second circuit.** Everything during the
 *   cooldown fails IMMEDIATELY — the callers already fall back to the
 *   untranslated text, and getting the original instantly reads far better
 *   than getting nothing slowly. Failures are never cached, so the first
 *   render after the cooldown tries again.
 * - **A 5xx or a network drop is retried once**, briefly. A rate limit is
 *   NOT — repeating a request Google just refused is how a cooldown becomes
 *   a ban.
 * - **A request whose retry ALSO fails transiently opens the circuit too.**
 *   Google's IP wall answers with a redirect the browser's CORS policy then
 *   blocks, and a CORS-blocked fetch rejects with a bare TypeError — there
 *   is no status to match, so the 429/403 check above can never see it.
 *   Before this, a walled client re-fired two doomed requests on every
 *   message render, forever (observed in the field 2026-08-16: a console
 *   full of CORS errors). Because the wall outlives any one cooldown, each
 *   consecutive opening doubles the cooldown up to 10 minutes; one success
 *   resets it to 30 seconds.
 *
 * ## A build can switch it off
 *
 * `VITE_CFG_ENABLE_GOOGLE_TRANSLATE=false` (the foss Android build) turns
 * translation off: `translationAvailable()` is false, and `translateText`
 * resolves `null` before the cache and without any request, so the callers
 * show the original as they do on any failure. Hiding the settings is not
 * enough on its own: captions translate with a default target, and settings
 * sync can carry `translation:enabled` from another device. The flag's
 * registry entry is `CONFIGURATION.ENABLE_GOOGLE_TRANSLATE` in `env.ts`, but
 * this file reads the variable itself, with the same parse, and imports
 * nothing: `env.ts` dereferences vite's env object at module load, and that
 * object doesn't exist under `node --test`.
 *
 * The factory takes its fetch so the specs can run the whole policy against
 * a scripted network — same reason the transcription engine takes a worker
 * factory. It takes the availability check for the same reason.
 */

/**
 * Languages offered as translation targets (Google Translate codes)
 */
export const TRANSLATE_LANGUAGES = [
  ["ar", "Arabic"],
  ["bn", "Bengali"],
  ["bg", "Bulgarian"],
  ["zh-CN", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["hr", "Croatian"],
  ["cs", "Czech"],
  ["da", "Danish"],
  ["nl", "Dutch"],
  ["en", "English"],
  ["et", "Estonian"],
  ["fil", "Filipino"],
  ["fi", "Finnish"],
  ["fr", "French"],
  ["de", "German"],
  ["el", "Greek"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["hu", "Hungarian"],
  ["id", "Indonesian"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["lv", "Latvian"],
  ["lt", "Lithuanian"],
  ["ms", "Malay"],
  ["no", "Norwegian"],
  ["fa", "Persian"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
  ["ro", "Romanian"],
  ["ru", "Russian"],
  ["sr", "Serbian"],
  ["sk", "Slovak"],
  ["sl", "Slovenian"],
  ["es", "Spanish"],
  ["sv", "Swedish"],
  ["th", "Thai"],
  ["tr", "Turkish"],
  ["uk", "Ukrainian"],
  ["vi", "Vietnamese"],
] as const;

export type TranslateLanguage = (typeof TRANSLATE_LANGUAGES)[number][0];

export const TRANSLATE_LANGUAGE_CODES = TRANSLATE_LANGUAGES.map(
  ([code]) => code,
) as string[];

/**
 * Human-readable name for a translation language code
 */
export function translateLanguageName(code: string): string {
  return TRANSLATE_LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
}

export interface TranslationResult {
  /** Translated text */
  text: string;
  /** Detected source language code */
  detectedSource: string;
}

/**
 * Messages longer than this are not translated (endpoint limit safety)
 */
const MAX_TRANSLATABLE_LENGTH = 4000;

/** How long one request may take before it is aborted. */
const REQUEST_TIMEOUT_MS = 7_000;

/** Requests allowed in flight at once; the rest wait their turn. */
const MAX_IN_FLIGHT = 2;

/** How long the circuit stays open after Google refuses a request. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

/**
 * Ceiling for the doubling cooldown under a persistent wall. High enough to
 * stop feeding a 40-hour IP ban, low enough that a fixed network (VPN off,
 * captive portal gone) is noticed within minutes.
 */
const MAX_COOLDOWN_MS = 600_000;

/** Pause before the single retry of a transiently failed request. */
const RETRY_DELAY_MS = 400;

const CACHE_LIMIT = 500;

/**
 * Compare only the primary subtag so e.g. detected "pt" matches target "pt-BR"
 */
function samePrimaryLanguage(a: string, b: string): boolean {
  return a.split("-")[0].toLowerCase() === b.split("-")[0].toLowerCase();
}

/** A failure worth one more attempt: a 5xx, or the network dropping. */
class RetryableError extends Error {}

export interface Translator {
  translateText(
    text: string,
    target: string,
  ): Promise<TranslationResult | null>;
}

/**
 * Build a translator around a fetch implementation. The default instance
 * below is what the app uses; specs construct their own with a scripted
 * fetch and mocked timers.
 */
export function createTranslator(
  // Wrapped rather than passed bare: an unbound `fetch` throws
  // "Illegal invocation" in browsers.
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  // Asked on every call, never captured. The app passes
  // `translationAvailable`.
  available: () => boolean = () => true,
): Translator {
  /** Bounded cache of finished/in-flight translations keyed by target + text */
  const cache = new Map<string, Promise<TranslationResult | null>>();

  let inFlight = 0;
  const waiters: (() => void)[] = [];
  /** Epoch ms until which the circuit is open. 0 = closed. */
  let rateLimitedUntil = 0;
  /** Next opening's duration; doubles per consecutive opening (see header). */
  let cooldownMs = RATE_LIMIT_COOLDOWN_MS;

  function coolingDown(): boolean {
    return Date.now() < rateLimitedUntil;
  }

  function openCircuit(): void {
    rateLimitedUntil = Date.now() + cooldownMs;
    cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
  }

  async function acquireSlot(): Promise<void> {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function releaseSlot(): void {
    // Hand the slot to the next waiter rather than freeing it, so the count
    // never dips and readmits two at once.
    const next = waiters.shift();
    if (next) next();
    else inFlight--;
  }

  /** One HTTP attempt, aborted at the deadline. */
  async function attempt(
    text: string,
    target: string,
  ): Promise<TranslationResult | null> {
    const params = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: target,
      dt: "t",
      dj: "1",
      q: text,
    });

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(
        "https://translate.googleapis.com/translate_a/single",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params,
          signal: controller.signal,
        },
      );

      if (response.status === 429 || response.status === 403) {
        openCircuit();
        throw new Error(`Translate rate limited: ${response.status}`);
      }
      if (!response.ok) {
        throw new RetryableError(`Translate failed: ${response.status}`);
      }

      // The endpoint is reachable and willing: future openings start from
      // the base cooldown again.
      cooldownMs = RATE_LIMIT_COOLDOWN_MS;

      const data: {
        sentences?: { trans?: string }[];
        src?: string;
      } = await response.json();

      const translated = (data.sentences ?? [])
        .map((sentence) => sentence.trans ?? "")
        .join("");
      const detectedSource = data.src ?? "und";

      if (
        !translated ||
        translated.trim() === text.trim() ||
        samePrimaryLanguage(detectedSource, target)
      ) {
        return null;
      }

      return { text: translated, detectedSource };
    } catch (error) {
      // The network dropping surfaces as a TypeError; that is worth a retry.
      // An abort (our own deadline) is not — the time budget is spent.
      if (error instanceof TypeError) throw new RetryableError(error.message);
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  /** The full policy: cooldown check, slot, attempt, one bounded retry. */
  async function requestTranslation(
    text: string,
    target: string,
  ): Promise<TranslationResult | null> {
    if (coolingDown()) throw new Error("Translate is cooling down");

    await acquireSlot();
    try {
      // The circuit may have opened while this request sat in the queue.
      if (coolingDown()) throw new Error("Translate is cooling down");

      try {
        return await attempt(text, target);
      } catch (error) {
        if (!(error instanceof RetryableError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        if (coolingDown()) throw error;
        try {
          return await attempt(text, target);
        } catch (retryError) {
          // Both attempts failed transiently: the endpoint is unreachable
          // from here (CORS wall, network down, persistent 5xx) and no
          // status-based check will ever fire. Open the circuit so the
          // callers stop paying for requests that cannot succeed.
          if (retryError instanceof RetryableError) openCircuit();
          throw retryError;
        }
      }
    } finally {
      releaseSlot();
    }
  }

  function translateText(
    text: string,
    target: string,
  ): Promise<TranslationResult | null> {
    // The build gate goes first: a refused call sends nothing, and it is
    // neither cached nor answered from the cache.
    if (!available()) return Promise.resolve(null);

    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_TRANSLATABLE_LENGTH) {
      return Promise.resolve(null);
    }

    const key = `${target} ${trimmed}`;
    const existing = cache.get(key);
    if (existing) return existing;

    const promise = requestTranslation(trimmed, target).catch(() => {
      // allow retry on transient failures
      cache.delete(key);
      return null;
    });

    if (cache.size >= CACHE_LIMIT) {
      // evict oldest entry (Map preserves insertion order)
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }

    cache.set(key, promise);
    return promise;
  }

  return { translateText };
}

/**
 * Whether this build may translate at all. On unless the build sets
 * `VITE_CFG_ENABLE_GOOGLE_TRANSLATE=false` (the foss Android build). The
 * same variable, with the same parse, as
 * `CONFIGURATION.ENABLE_GOOGLE_TRANSLATE` in `env.ts`, which this file can't
 * import (see the header). It is read inside the function, never at module
 * scope: vite replaces the keyed read at build time, and the specs never
 * call it under node, where the env object doesn't exist.
 */
export function translationAvailable(): boolean {
  return (
    (
      (import.meta.env.VITE_CFG_ENABLE_GOOGLE_TRANSLATE as string) ?? ""
    ).toLowerCase() !== "false"
  );
}

const shared = createTranslator(undefined, translationAvailable);

/**
 * Translate text into the target language, detecting the source language.
 * Resolves to `null` when translation is unnecessary (already in the target
 * language, empty, too long), when the request fails, or when this build has
 * translation switched off (`translationAvailable()`).
 */
export function translateText(
  text: string,
  target: string,
): Promise<TranslationResult | null> {
  return shared.translateText(text, target);
}
