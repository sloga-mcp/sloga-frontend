/**
 * The Cipher founding-supporter badge: reading `user.cipher`, the label, and
 * the stylesheet for the animated top tier. Kept free of Solid and stoat.js so
 * `node --test` can load it.
 */

/** A Cipher membership as the profile shows it (the server assigns both) */
export type CipherBadgeData = { number: number; tier: string };

/** The tier whose badge gets the animated shine */
export const ANIMATED_CIPHER_TIER = "T299";

/** Class carrying the shine animation; defined in CIPHER_BADGE_SHEET */
export const CIPHER_BADGE_SHINE_CLASS = "sloga-cipher-badge-shine";

const SHEET_ID = "sloga-cipher-badge-styles";

/**
 * Read a user's Cipher membership, or undefined if there is none or it is
 * malformed. Takes the user as a plain object so it compiles whether or not
 * the stoat.js `User` type declares `cipher` yet; the property read still
 * goes through the reactive getter.
 */
export function readUserCipher(
  user: object | undefined,
): CipherBadgeData | undefined {
  const raw = (user as { cipher?: unknown } | undefined)?.cipher;
  if (!raw || typeof raw !== "object") return undefined;

  const { number, tier } = raw as { number?: unknown; tier?: unknown };
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    return undefined;
  }
  if (typeof tier !== "string") return undefined;

  return { number, tier };
}

/** The membership number, zero-padded to four digits: 42 becomes "0042" */
export function formatCipherNumber(number: number): string {
  return String(number).padStart(4, "0");
}

/**
 * Visible badge text, e.g. "Cipher #0042". Not localized: "Cipher" is the
 * product name and the number reads the same in every locale.
 */
export function cipherBadgeLabel(number: number): string {
  return `Cipher #${formatCipherNumber(number)}`;
}

/** Whether this tier's badge animates */
export function isAnimatedCipherTier(tier: string): boolean {
  return tier === ANIMATED_CIPHER_TIER;
}

/**
 * A soft highlight sweeps across the badge, then rests. Both ends of the
 * sweep sit outside the badge, so the resting frame is clean. Under reduced
 * motion the animation and the highlight are both removed.
 */
export const CIPHER_BADGE_SHEET = `
.${CIPHER_BADGE_SHINE_CLASS} {
  background-image: linear-gradient(110deg, transparent 45%, rgba(255, 255, 255, 0.35) 50%, transparent 55%);
  background-size: 300% 100%;
  background-repeat: no-repeat;
  background-position: 100% 0;
  animation: sloga-cipher-badge-shine 6s ease-in-out infinite;
}

@keyframes sloga-cipher-badge-shine {
  0% { background-position: 100% 0; }
  35%, 100% { background-position: 0% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .${CIPHER_BADGE_SHINE_CLASS} {
    animation: none;
    background-image: none;
  }
}
`;

/**
 * Inject CIPHER_BADGE_SHEET once (id "sloga-cipher-badge-styles"); no-op
 * without a document.
 */
export function ensureCipherBadgeSheet(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SHEET_ID)) return;

  const sheet = document.createElement("style");
  sheet.id = SHEET_ID;
  sheet.textContent = CIPHER_BADGE_SHEET;
  document.head.appendChild(sheet);
}
