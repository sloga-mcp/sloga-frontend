const PREFIX = "[acupass:";
const SUFFIX = "]";

/**
 * Parse a channel description to extract a password hash.
 * The hash is stored on the last line as [acupass:HASH].
 */
export function parseChannelPassword(description: string | undefined): {
  cleanDescription: string;
  passwordHash: string | null;
} {
  if (!description) return { cleanDescription: "", passwordHash: null };

  const lines = description.split("\n");
  const last = lines[lines.length - 1];

  if (last.startsWith(PREFIX) && last.endsWith(SUFFIX)) {
    const hash = last.slice(PREFIX.length, -SUFFIX.length);
    const clean = lines.slice(0, -1).join("\n");
    return { cleanDescription: clean, passwordHash: hash };
  }

  return { cleanDescription: description, passwordHash: null };
}

/**
 * Append a password hash to a description string.
 */
export function buildDescriptionWithHash(
  cleanDescription: string,
  hash: string,
): string {
  const base = cleanDescription.trim();
  return base ? `${base}\n${PREFIX}${hash}${SUFFIX}` : `${PREFIX}${hash}${SUFFIX}`;
}

/**
 * SHA-256 hash a password string, returns hex string.
 */
export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
