// Specs for the Cipher badge helpers — run with Node's built-in runner:
//   node --conditions=browser --test components/ui/components/features/profiles/cipherBadge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANIMATED_CIPHER_TIER,
  CIPHER_BADGE_OPEN_CLASS,
  CIPHER_BADGE_SHACKLE_CLASS,
  CIPHER_BADGE_SHEET,
  CIPHER_BADGE_SHINE_CLASS,
  CIPHER_DECRYPT_EVERY_MS,
  CIPHER_DECRYPT_MS,
  CIPHER_SCRAMBLE_GLYPHS,
  cipherBadgeLabel,
  cipherScrambleFrame,
  ensureCipherBadgeSheet,
  formatCipherNumber,
  isAnimatedCipherTier,
  readUserCipher,
} from "./cipherBadge.ts";

test("numbers are zero-padded to four digits", () => {
  assert.equal(formatCipherNumber(1), "0001");
  assert.equal(formatCipherNumber(42), "0042");
  assert.equal(formatCipherNumber(999), "0999");
  assert.equal(formatCipherNumber(1000), "1000");
});

test("numbers past four digits are shown whole, never truncated", () => {
  assert.equal(formatCipherNumber(12345), "12345");
});

test("the label reads Cipher #NNNN", () => {
  assert.equal(cipherBadgeLabel(42), "Cipher #0042");
  assert.equal(cipherBadgeLabel(7), "Cipher #0007");
  assert.equal(cipherBadgeLabel(1000), "Cipher #1000");
});

test("readUserCipher returns the membership the server sent", () => {
  assert.deepEqual(readUserCipher({ cipher: { number: 42, tier: "T149" } }), {
    number: 42,
    tier: "T149",
  });
});

test("readUserCipher goes through a getter, as stoat.js exposes it", () => {
  const user = {
    get cipher() {
      return { number: 3, tier: "T299" };
    },
  };
  assert.deepEqual(readUserCipher(user), { number: 3, tier: "T299" });
});

test("no membership, or a malformed one, shows no badge", () => {
  assert.equal(readUserCipher(undefined), undefined);
  assert.equal(readUserCipher({}), undefined);
  assert.equal(readUserCipher({ cipher: undefined }), undefined);
  assert.equal(readUserCipher({ cipher: null }), undefined);
  assert.equal(readUserCipher({ cipher: "T299" }), undefined);
  for (const number of [0, -1, 1.5, NaN, Infinity, "42", undefined]) {
    assert.equal(
      readUserCipher({ cipher: { number, tier: "T99" } }),
      undefined,
      `number ${String(number)}`,
    );
  }
  assert.equal(readUserCipher({ cipher: { number: 42 } }), undefined);
  assert.equal(
    readUserCipher({ cipher: { number: 42, tier: 299 } }),
    undefined,
  );
});

test("an unknown future tier still shows the badge, unanimated", () => {
  const cipher = readUserCipher({ cipher: { number: 5, tier: "T499" } });
  assert.deepEqual(cipher, { number: 5, tier: "T499" });
  assert.equal(isAnimatedCipherTier(cipher!.tier), false);
});

test("only T299 animates", () => {
  assert.equal(ANIMATED_CIPHER_TIER, "T299");
  assert.equal(isAnimatedCipherTier("T299"), true);
  assert.equal(isAnimatedCipherTier("T149"), false);
  assert.equal(isAnimatedCipherTier("T99"), false);
  assert.equal(isAnimatedCipherTier("t299"), false);
});

test("the sheet animates the shine layer and defines its keyframes", () => {
  assert.match(
    CIPHER_BADGE_SHEET,
    new RegExp(
      `\\.${CIPHER_BADGE_SHINE_CLASS}::after \\{[^}]*z-index: -1;[^}]*animation: sloga-cipher-badge-shine 3s `,
    ),
  );
  assert.ok(CIPHER_BADGE_SHEET.includes("@keyframes sloga-cipher-badge-shine"));
});

test("the top tier gets the blue to orange fill with dark ink, above the badge's own colors", () => {
  assert.match(
    CIPHER_BADGE_SHEET,
    new RegExp(
      `\\.${CIPHER_BADGE_SHINE_CLASS}\\.${CIPHER_BADGE_SHINE_CLASS} \\{[^}]*isolation: isolate;[^}]*color: #11190e;[^}]*linear-gradient\\(120deg, #3bb8ed 0%, #c05fc8 55%, #f5870d 100%\\);[^}]*linear-gradient\\(in oklch longer hue 120deg, #3bb8ed 0%, #f5870d 100%\\)`,
    ),
  );
});

test("reduced motion removes the sweep and keeps the fill", () => {
  assert.match(
    CIPHER_BADGE_SHEET,
    new RegExp(
      `@media \\(prefers-reduced-motion: reduce\\) \\{\\s*\\.${CIPHER_BADGE_SHINE_CLASS}::after \\{[^}]*animation: none;[^}]*background-image: none;`,
    ),
  );
  const reduced = CIPHER_BADGE_SHEET.slice(
    CIPHER_BADGE_SHEET.indexOf("@media (prefers-reduced-motion"),
  );
  assert.ok(
    !reduced.includes("#f5870d"),
    "the fill is not removed under reduced motion",
  );
});

test("a scramble frame keeps the revealed part and the spaces", () => {
  const label = "Cipher #0042";
  const first = () => 0;

  const none = cipherScrambleFrame(label, 0, first);
  assert.equal(none.length, label.length);
  assert.equal(none[6], " ");
  for (let i = 0; i < label.length; i++) {
    if (i !== 6) assert.equal(none[i], CIPHER_SCRAMBLE_GLYPHS[0], `index ${i}`);
  }

  assert.equal(
    cipherScrambleFrame(label, 3, first),
    "Cip" +
      CIPHER_SCRAMBLE_GLYPHS[0].repeat(3) +
      " " +
      CIPHER_SCRAMBLE_GLYPHS[0].repeat(5),
  );
  assert.equal(cipherScrambleFrame(label, label.length, first), label);
  assert.equal(cipherScrambleFrame(label, label.length + 5, first), label);
});

test("scramble symbols stay in range for any random value", () => {
  for (const value of [0, 0.5, 0.999999, 1, -1, NaN]) {
    const frame = cipherScrambleFrame("ab", 0, () => value);
    for (const char of frame) {
      assert.ok(CIPHER_SCRAMBLE_GLYPHS.includes(char), `value ${value}`);
    }
  }
});

test("scramble symbols are single code units with no direction controls", () => {
  for (const glyph of CIPHER_SCRAMBLE_GLYPHS) {
    assert.equal(glyph.length, 1, glyph);
    const code = glyph.codePointAt(0) ?? 0;
    const control =
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    assert.ok(!control, "no zero width or direction control");
  }
});

test("the decrypt is slow and repeats with a rest between runs", () => {
  assert.equal(CIPHER_DECRYPT_MS, 3000);
  assert.ok(CIPHER_DECRYPT_EVERY_MS > CIPHER_DECRYPT_MS);
});

test("the lock opens under the open class and snaps under reduced motion", () => {
  assert.match(
    CIPHER_BADGE_SHEET,
    new RegExp(
      `\\.${CIPHER_BADGE_OPEN_CLASS} \\.${CIPHER_BADGE_SHACKLE_CLASS} \\{[^}]*transform: translateY`,
    ),
  );
  const reduced = CIPHER_BADGE_SHEET.slice(
    CIPHER_BADGE_SHEET.indexOf("@media (prefers-reduced-motion"),
  );
  assert.match(
    reduced,
    new RegExp(`\\.${CIPHER_BADGE_SHACKLE_CLASS} \\{\\s*transition: none;`),
  );
});

test("the sheet is injected once, and not at all without a document", () => {
  ensureCipherBadgeSheet(); // no document in node: must not throw

  const appended: { id: string; textContent: string }[] = [];
  const fake = {
    getElementById: (id: string) => appended.find((el) => el.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "" }),
    head: {
      appendChild: (el: { id: string; textContent: string }) => {
        appended.push(el);
      },
    },
  };
  const global = globalThis as { document?: unknown };
  global.document = fake;
  try {
    ensureCipherBadgeSheet();
    ensureCipherBadgeSheet();
  } finally {
    delete global.document;
  }

  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, "sloga-cipher-badge-styles");
  assert.equal(appended[0].textContent, CIPHER_BADGE_SHEET);
});
