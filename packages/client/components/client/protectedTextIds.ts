/**
 * Protected channels: text group ids and the router's id index (W4 lane A4).
 *
 * A text group id is deterministic in the channel id (design 3.1):
 *
 *   lowercase_hex(SHA-256(UTF-8("sloga-text-group-v1" LF channel_id LF decimal(g))))
 *
 * where `g` is the generation, `0..=MAX_TEXT_GENERATION`. The server
 * (`routes/mls/text.rs` `text_group_id`) and native (`mls/text/formats.rs`
 * `text_group_id`) carry their own copies; the design 5.5 vectors pin all
 * three byte for byte. Like native, this copy refuses a channel id that is not
 * a ULID and a generation outside `0..=63`, so no caller can derive a group
 * the server would refuse.
 *
 * `TextIdIndex` is the routing seam's lookup (plan D4): every id of
 * generations 0..63 for every server-protected OR pinned channel, so an
 * inbound MLS envelope whose group id is in the index goes to the text plane
 * and never to the call session. It only grows: protection and pins are
 * one-way, and a stale entry merely keeps a dead id off the call path.
 *
 * Pure module: WebCrypto (`crypto.subtle`, browser and node) only; no Solid,
 * no SDK. Holds no key material.
 */

/** The highest text-group generation (design 3.1); `64` is refused. */
export const MAX_TEXT_GENERATION = 63;

/** Domain-separation context (design 0.4; WIRE FORMAT, never rename). */
export const TEXT_GROUP_ID_CONTEXT = "sloga-text-group-v1";

/** What an indexed group id stands for. */
export interface TextGroupRef {
  channelId: string;
  generation: number;
}

/** ULID charset (design 0.1): Crockford base32, uppercase, 26 chars. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isValidGeneration(generation: number): boolean {
  return (
    Number.isInteger(generation) &&
    generation >= 0 &&
    generation <= MAX_TEXT_GENERATION
  );
}

function toHex(bytes: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(bytes)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * The text group id of `channelId` at `generation` (design 3.1).
 * Rejects (`RangeError`) a channel id that is not a ULID or a generation that
 * is not an integer in `0..=MAX_TEXT_GENERATION`.
 */
export async function textGroupId(
  channelId: string,
  generation: number,
): Promise<string> {
  if (typeof channelId !== "string" || !ULID_RE.test(channelId)) {
    throw new RangeError("textGroupId: channel id is not a ULID");
  }
  if (!isValidGeneration(generation)) {
    throw new RangeError(
      `textGroupId: generation outside 0..=${MAX_TEXT_GENERATION}`,
    );
  }
  const input = new TextEncoder().encode(
    `${TEXT_GROUP_ID_CONTEXT}\n${channelId}\n${generation}`,
  );
  return toHex(await crypto.subtle.digest("SHA-256", input));
}

/**
 * Group id -> `{channelId, generation}` for every generation 0..63 of every
 * added channel. `ready` flips once (`markReady`) after the Ready-time seeding
 * has been awaited; before that the router holds envelopes (plan D4 step 2).
 * Channels added after ready (a new pin, a channel protected later) are
 * indexed as soon as their `addChannel` resolves; callers AWAIT it before any
 * `_join` / `_group_create` for that channel (PA#11f).
 */
export class TextIdIndex {
  #ids = new Map<string, TextGroupRef>();
  #channels = new Map<string, Promise<void>>();
  #ready = false;

  /** True when `groupId` is a text group id of an indexed channel. */
  has(groupId: string): boolean {
    return this.#ids.has(groupId);
  }

  /** The channel and generation `groupId` derives from, or null. */
  get(groupId: string): TextGroupRef | null {
    const ref = this.#ids.get(groupId);
    return ref ? { ...ref } : null;
  }

  /**
   * Index all 64 ids of `channelId`. Idempotent: a repeat (or concurrent)
   * call shares the first call's promise. The ids enter the index together,
   * only after all 64 are derived. Rejects (and indexes nothing, so a later
   * call may retry) on an invalid channel id or a digest failure.
   */
  addChannel(channelId: string): Promise<void> {
    const pending = this.#channels.get(channelId);
    if (pending) return pending;
    const work = this.#derive(channelId);
    this.#channels.set(channelId, work);
    work.catch(() => {
      if (this.#channels.get(channelId) === work) {
        this.#channels.delete(channelId);
      }
    });
    return work;
  }

  /** Seeding is complete; the router may stop holding envelopes. */
  markReady(): void {
    this.#ready = true;
  }

  get ready(): boolean {
    return this.#ready;
  }

  async #derive(channelId: string): Promise<void> {
    const generations = Array.from(
      { length: MAX_TEXT_GENERATION + 1 },
      (_, g) => g,
    );
    const ids = await Promise.all(
      generations.map((g) => textGroupId(channelId, g)),
    );
    for (const [generation, id] of ids.entries()) {
      const prior = this.#ids.get(id);
      if (
        prior &&
        (prior.channelId !== channelId || prior.generation !== generation)
      ) {
        // A SHA-256 collision; refuse rather than reroute an indexed id.
        throw new Error("TextIdIndex: group id collision");
      }
    }
    for (const [generation, id] of ids.entries()) {
      this.#ids.set(id, { channelId, generation });
    }
  }
}
