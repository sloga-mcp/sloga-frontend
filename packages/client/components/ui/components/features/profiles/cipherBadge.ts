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

/** How long the top tier's label takes to decrypt, left to right */
export const CIPHER_DECRYPT_MS = 3000;

/** How often the label scrambles and decrypts again while it is shown */
export const CIPHER_DECRYPT_EVERY_MS = 10000;

/** Class on the lock's shackle; it swings open under CIPHER_BADGE_OPEN_CLASS */
export const CIPHER_BADGE_SHACKLE_CLASS = "sloga-cipher-badge-shackle";

/** Class on the lock once the label reads in full */
export const CIPHER_BADGE_OPEN_CLASS = "sloga-cipher-badge-open";

/**
 * Symbols the scrambled label is drawn from: block shades, diamonds and Greek
 * capitals, which every platform font has, plus ASCII punctuation. Kept as
 * code points so this file stays ASCII.
 */
export const CIPHER_SCRAMBLE_GLYPHS: readonly string[] = [
  0x2591, 0x2592, 0x2593, 0x259a, 0x259e, 0x25c6, 0x25c7, 0x25c8, 0x039e,
  0x03a3, 0x039b, 0x0394, 0x03a8, 0x03a9,
]
  .map((code) => String.fromCodePoint(code))
  .concat("#$%&@*+=<>/01".split(""));

/**
 * One frame of the decrypt: the first `revealed` characters of `target` are
 * shown as they are, the rest are scrambled symbols. Spaces stay spaces so the
 * words keep their shape. `random` returns a number in [0, 1), like
 * Math.random.
 */
export function cipherScrambleFrame(
  target: string,
  revealed: number,
  random: () => number,
): string {
  let frame = "";
  for (let i = 0; i < target.length; i++) {
    const char = target[i];
    if (i < revealed || char === " ") {
      frame += char;
    } else {
      const last = CIPHER_SCRAMBLE_GLYPHS.length - 1;
      const pick = Math.floor(random() * CIPHER_SCRAMBLE_GLYPHS.length);
      frame +=
        CIPHER_SCRAMBLE_GLYPHS[
          Number.isFinite(pick) ? Math.min(Math.max(pick, 0), last) : 0
        ];
    }
  }
  return frame;
}

/**
 * The top tier's badge: the light blue of the Sloga logo fading into its
 * orange, with dark ink and a soft glow, so it reads the same on light and
 * dark themes. The blend takes the long way round the hue wheel in oklch, so
 * it passes through violet and pink; the plain gradient before it, through
 * the logo's purple, is for browsers without oklch gradients. A bright highlight
 * sweeps across it every three seconds; the sweep sits on a layer under the
 * text (z-index -1 inside the isolated badge), and both ends of it sit outside
 * the badge, so the resting frame is clean. The doubled class outranks the
 * badge's own colors. Under reduced motion the sweep is removed and the
 * colors stay.
 */
export const CIPHER_BADGE_SHEET = `
.${CIPHER_BADGE_SHINE_CLASS}.${CIPHER_BADGE_SHINE_CLASS} {
  position: relative;
  overflow: hidden;
  isolation: isolate;
  gap: 5px;
  padding-inline: 7px 9px;
  color: #11190e;
  background-color: #3bb8ed;
  background-image: linear-gradient(120deg, #3bb8ed 0%, #c05fc8 55%, #f5870d 100%);
  background-image: linear-gradient(in oklch longer hue 120deg, #3bb8ed 0%, #f5870d 100%);
  border-color: rgba(255, 255, 255, 0.45);
  box-shadow: 0 0 0 1px rgba(245, 135, 13, 0.35), 0 0 10px rgba(245, 135, 13, 0.45);
}

.${CIPHER_BADGE_SHINE_CLASS}::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image: linear-gradient(110deg, transparent 35%, rgba(255, 255, 255, 0.85) 50%, transparent 65%);
  background-size: 250% 100%;
  background-repeat: no-repeat;
  background-position: 120% 0;
  animation: sloga-cipher-badge-shine 3s ease-in-out infinite;
}

@keyframes sloga-cipher-badge-shine {
  0% { background-position: 120% 0; }
  40%, 100% { background-position: -20% 0; }
}

.${CIPHER_BADGE_SHACKLE_CLASS} {
  transform-box: fill-box;
  transform-origin: 100% 100%;
  transition: transform 0.35s ease;
}

.${CIPHER_BADGE_OPEN_CLASS} .${CIPHER_BADGE_SHACKLE_CLASS} {
  transform: translateY(-1.6px) rotate(28deg);
}

@media (prefers-reduced-motion: reduce) {
  .${CIPHER_BADGE_SHINE_CLASS}::after {
    animation: none;
    background-image: none;
  }

  .${CIPHER_BADGE_SHACKLE_CLASS} {
    transition: none;
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
