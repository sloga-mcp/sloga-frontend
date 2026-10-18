// Specs for the Cipher badge helpers — run with Node's built-in runner:
//   node --conditions=browser --test components/ui/components/features/profiles/cipherBadge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANIMATED_CIPHER_TIER,
  CIPHER_BADGE_SHEET,
  CIPHER_BADGE_SHINE_CLASS,
  cipherBadgeLabel,
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

test("the sheet animates the shine class and defines its keyframes", () => {
  assert.match(
    CIPHER_BADGE_SHEET,
    new RegExp(
      `\\.${CIPHER_BADGE_SHINE_CLASS} \\{[^}]*animation: sloga-cipher-badge-shine `,
    ),
  );
  assert.ok(CIPHER_BADGE_SHEET.includes("@keyframes sloga-cipher-badge-shine"));
});

test("reduced motion removes the animation and the highlight", () => {
  assert.match(
    CIPHER_BADGE_SHEET,
    new RegExp(
      `@media \\(prefers-reduced-motion: reduce\\) \\{\\s*\\.${CIPHER_BADGE_SHINE_CLASS} \\{[^}]*animation: none;[^}]*background-image: none;`,
    ),
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
