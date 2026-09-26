/**
 * Run with:
 *
 *     node --conditions=browser --test components/ui/components/features/messaging/elements/audioEmbed.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests. This file
 * is pure and unaffected, but one invocation should cover it and the reactive
 * suites together.)
 *
 * These are the two decisions behind the audio link embed card (`./Embed.tsx`
 * and `./FileInfo.tsx`), which are `.tsx` files reaching `solid-js` and
 * `stoat.js` and so cannot be loaded by a unit runner. `./audioEmbed.ts`
 * imports nothing at runtime, and the fixtures here are plain objects typed as
 * `AudioEmbedLike`, so no client or DOM is needed. Each `describe` names the
 * decision and the production failure it prevents.
 *
 * The one that matters most is **"no proxied URL means no player, whatever
 * the browser says"**: the player's only legal source is the January proxy.
 * If the helper answered true without one, the card would mount an `<audio>`
 * with no source (or tempt a caller to fall back to the raw `url`, which would
 * make every reader's browser fetch the poster's link directly and leak their
 * IP to it).
 *
 * Known-bad controls recorded in the lane report: inverting the `canPlayType`
 * check, and answering true when `proxiedURL` is undefined, must each turn a
 * spec here red.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AudioEmbedLike,
  audioEmbedFilename,
  shouldRenderAudioPlayer,
} from "./audioEmbed.ts";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

const PROXIED = "https://january.example/audio?url=https%3A%2F%2Fh%2Fa.mp3";

/**
 * An audio embed with a proxied URL and no filename.
 *
 * The base is a full literal typed as `AudioEmbedLike`, so a field the type
 * gains later is a compile error here rather than a silent `undefined`.
 */
function embed(overrides: Partial<AudioEmbedLike> = {}): AudioEmbedLike {
  const base: AudioEmbedLike = {
    url: "https://h/a.mp3",
    contentType: "audio/mpeg",
    filename: undefined,
    proxiedURL: PROXIED,
  };
  return { ...base, ...overrides };
}

/** A `canPlayType` stand-in that always answers `answer`. */
function answers(answer: string): (type: string) => string {
  return () => answer;
}

/* ------------------------------------------------------------------------ *
 * audioEmbedFilename
 * ------------------------------------------------------------------------ */

/*
 * Prevents: the card showing a percent-encoded blob (`a%20b.mp3`), an empty
 * name for a URL ending in `/`, or the whole message list throwing when a
 * link carries a malformed escape (`decodeURIComponent` throws `URIError`,
 * and a throw inside a render takes the channel view down with it).
 */
describe("audioEmbedFilename", () => {
  it("uses the server-supplied filename when set", () => {
    assert.equal(
      audioEmbedFilename(
        embed({ url: "https://h/other.mp3", filename: "Song Title.mp3" }),
      ),
      "Song Title.mp3",
    );
  });

  it("falls back to the last path segment, percent-decoded", () => {
    assert.equal(
      audioEmbedFilename(embed({ url: "https://h/a%20b.mp3" })),
      "a b.mp3",
    );
  });

  it("takes the last segment of a nested path, without the query", () => {
    assert.equal(
      audioEmbedFilename(embed({ url: "https://h/music/2024/c.ogg?sig=x" })),
      "c.ogg",
    );
  });

  it("skips a trailing slash to the last non-empty segment", () => {
    assert.equal(audioEmbedFilename(embed({ url: "https://h/dir/" })), "dir");
  });

  it("keeps the raw segment on a malformed escape instead of throwing", () => {
    const target = embed({ url: "https://h/%E0%A4%A" });
    assert.doesNotThrow(() => audioEmbedFilename(target));
    assert.equal(audioEmbedFilename(target), "%E0%A4%A");
  });

  it("falls back to the host when the URL has no path", () => {
    assert.equal(audioEmbedFilename(embed({ url: "https://h/" })), "h");
  });

  it("falls back to the raw url when it cannot be parsed", () => {
    const target = embed({ url: "not a url" });
    assert.doesNotThrow(() => audioEmbedFilename(target));
    assert.equal(audioEmbedFilename(target), "not a url");
  });
});

/*
 * Prevents: a name that reorders itself on screen. Bidi isolation on the
 * rendered name keeps an override from flipping the surrounding UI, but not
 * from reversing the name's own tail, so `song<U+202E>3pm.exe` would display
 * as `songexe.mp3`. Also prevents the card showing a different name from the
 * server's: January strips every Unicode control (C0, DEL and C1, the
 * U+0080-U+009F range included) plus the same bidi set, so the client must
 * strip no less. The controls are written as escapes here on purpose: a
 * literal one in this file would reorder the source itself.
 */
describe("audioEmbedFilename strips bidi and control characters", () => {
  it("removes a right-to-left override from the server-supplied filename", () => {
    assert.equal(
      audioEmbedFilename(embed({ filename: "song\u202E3pm.exe" })),
      "song3pm.exe",
    );
  });

  it("removes a percent-encoded override from the URL path segment", () => {
    assert.equal(
      audioEmbedFilename(embed({ url: "https://h/song%E2%80%AE3pm.exe" })),
      "song3pm.exe",
    );
  });

  it("removes C1 controls from the server-supplied filename", () => {
    assert.equal(
      audioEmbedFilename(embed({ filename: "a\u0085b\u009Bc.mp3" })),
      "abc.mp3",
    );
  });

  it("removes percent-encoded C1 controls from the URL path segment", () => {
    assert.equal(
      audioEmbedFilename(embed({ url: "https://h/a%C2%85b%C2%9Bc.mp3" })),
      "abc.mp3",
    );
  });

  it("strips the whole C1 range (U+0080-U+009F) but keeps U+00A0", () => {
    assert.equal(
      audioEmbedFilename(embed({ filename: "a\u0080b\u009Fc\u00A0d.mp3" })),
      "abc\u00A0d.mp3",
    );
  });

  it("falls through to the URL segment when the filename is only controls", () => {
    const filename = "\u202E\u2066\u200F";
    assert.equal(
      audioEmbedFilename(embed({ url: "https://h/a.mp3", filename })),
      "a.mp3",
    );
  });
});

/* ------------------------------------------------------------------------ *
 * shouldRenderAudioPlayer
 * ------------------------------------------------------------------------ */

/*
 * Prevents: a player with no proxied source (January disabled) being
 * mounted at all, and a player being shown for a format this browser cannot
 * decode, which renders a dead control with a disabled play button instead
 * of just the card with its "open original" link.
 */
describe("shouldRenderAudioPlayer", () => {
  it("no proxied URL means no player, whatever the browser says", () => {
    assert.equal(
      shouldRenderAudioPlayer(
        embed({ proxiedURL: undefined }),
        answers("probably"),
      ),
      false,
    );
  });

  it('hides the player when canPlayType answers ""', () => {
    assert.equal(shouldRenderAudioPlayer(embed(), answers("")), false);
  });

  it('shows the player when canPlayType answers "maybe"', () => {
    assert.equal(shouldRenderAudioPlayer(embed(), answers("maybe")), true);
  });

  it('shows the player when canPlayType answers "probably"', () => {
    assert.equal(shouldRenderAudioPlayer(embed(), answers("probably")), true);
  });

  it("asks canPlayType about the embed's content type", () => {
    const asked: string[] = [];
    const contentType = "audio/ogg; codecs=opus";
    shouldRenderAudioPlayer(embed({ contentType }), (type) => {
      asked.push(type);
      return "maybe";
    });
    assert.deepEqual(asked, [contentType]);
  });
});
