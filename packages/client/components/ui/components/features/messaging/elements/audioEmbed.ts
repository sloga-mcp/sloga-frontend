/**
 * The two decisions behind the audio link embed card: what to call the file,
 * and whether to mount a player for it at all.
 *
 * `./Embed.tsx` and `./FileInfo.tsx` reach `solid-js` and `stoat.js`, so
 * nothing declared inside them is loadable by `node --test`. These decisions
 * live here instead, and the components keep only the composition
 * (`./audioEmbed.test.ts` covers this file).
 *
 * The only import is `import type`, which Node's type-stripping erases
 * entirely, so the runner never loads the `stoat.js` runtime. Keep it that
 * way: a value import from `stoat.js`, `solid-js` or any `@revolt/*` alias
 * would put this module out of reach of the spec.
 */
import type { AudioEmbed } from "stoat.js";

/**
 * The parts of an audio embed these decisions read
 *
 * A `Pick` rather than the class itself, so the spec can pass plain objects
 * without constructing a client.
 */
export type AudioEmbedLike = Pick<
  AudioEmbed,
  "url" | "contentType" | "filename" | "proxiedURL"
>;

/**
 * C0, DEL and C1 controls (U+0000-U+001F, U+007F-U+009F) and every bidi mark,
 * embedding, override and isolate
 *
 * The same set January strips server-side (Rust's `char::is_control` plus
 * its bidi list), so a name reads the same whichever side produced it.
 */
const UNSAFE_NAME_CHARS =
  // eslint-disable-next-line no-control-regex -- matching controls is the point
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Name to display for an audio embed
 *
 * In order: the server-supplied filename; else the URL's last non-empty path
 * segment, percent-decoded (a malformed escape keeps the raw segment, since
 * `decodeURIComponent` throws `URIError` and a throw here would take the
 * message list down with it); else the URL's host; else the raw url.
 *
 * The result is untrusted text from a third-party link. The caller renders it
 * bidi-isolated, so a right-to-left override inside it cannot flip the
 * surrounding UI, but isolation cannot stop it reordering the name itself
 * (`song%E2%80%AE3pm.exe` would display as `songexe.mp3`). So controls and
 * bidi formatting characters are stripped from every candidate, after
 * decoding, and a candidate left empty falls through to the next.
 * @param embed Audio embed
 * @returns Display name, never empty unless the stripped url itself is
 */
export function audioEmbedFilename(embed: AudioEmbedLike): string {
  const filename = stripUnsafe(embed.filename ?? "");
  if (filename) return filename;

  let parsed: URL;
  try {
    parsed = new URL(embed.url);
  } catch {
    return stripUnsafe(embed.url);
  }

  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      decoded = last;
    }

    const segment = stripUnsafe(decoded);
    if (segment) return segment;
  }

  return parsed.host || stripUnsafe(embed.url);
}

/**
 * Remove the characters a display name must not carry
 * @param text Untrusted text
 * @returns The text without any `UNSAFE_NAME_CHARS`
 */
function stripUnsafe(text: string): string {
  return text.replace(UNSAFE_NAME_CHARS, "");
}

/**
 * Whether to mount an `<audio>` player for an audio embed
 *
 * The January proxy is the player's only legal source: the raw `url` would
 * make every reader's browser fetch the poster's link directly and leak their
 * IP to it. So no proxied URL means no player, whatever the browser says, and
 * the card falls back to its "open original" link.
 *
 * Otherwise the browser decides: `canPlayType` answering `""` means it cannot
 * decode the format, and a player would render as a dead control.
 * @param embed Audio embed
 * @param canPlayType The browser's `HTMLMediaElement.canPlayType`, injected
 * so this stays loadable without a DOM
 * @returns True when a player should be mounted
 */
export function shouldRenderAudioPlayer(
  embed: AudioEmbedLike,
  canPlayType: (type: string) => string,
): boolean {
  if (!embed.proxiedURL) return false;

  return canPlayType(embed.contentType) !== "";
}
