/**
 * Pure decisions behind the Cipher promo on the auth screens, kept out of the
 * component so `node --test` can load them.
 */

/** The Cipher page on sloga.gg */
export const CIPHER_URL = "https://sloga.gg/cipher/";

/** Its Brazilian Portuguese version */
export const CIPHER_URL_PT = "https://sloga.gg/pt-br/cipher/";

/**
 * The Cipher page in the reader's language. Locale keys arrive as `pt_BR`,
 * `pt-PT` or plain `pt`; every Portuguese one gets the pt-BR page, the site's
 * only translation.
 */
export function cipherPromoUrl(locale: string | undefined): string {
  return /^pt(?:[-_]|$)/i.test(locale ?? "") ? CIPHER_URL_PT : CIPHER_URL;
}

/**
 * Format a whole number for the reader's locale (1,000 / 1.000), falling back
 * to plain digits when the locale key is not one `Intl` knows.
 */
export function formatCount(value: number, locale: string | undefined): string {
  try {
    return new Intl.NumberFormat((locale ?? "en").replace(/_/g, "-")).format(
      value,
    );
  } catch {
    return String(value);
  }
}
