// Unit spec for the Cipher promo helpers — run with Node's built-in runner:
//   node --conditions=browser --test components/auth/src/cipherPromoPolicy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CIPHER_URL,
  CIPHER_URL_PT,
  cipherPromoUrl,
  formatCount,
} from "./cipherPromoPolicy.ts";

test("Portuguese locales open the pt-BR Cipher page", () => {
  for (const locale of ["pt_BR", "pt-BR", "pt_PT", "pt-PT", "pt", "PT_br"]) {
    assert.equal(cipherPromoUrl(locale), CIPHER_URL_PT, locale);
  }
});

test("every other locale opens the English Cipher page", () => {
  for (const locale of [
    "en",
    "en_US",
    "es",
    "es_419",
    "ptx",
    "portuguese",
    "",
    undefined,
  ]) {
    assert.equal(cipherPromoUrl(locale), CIPHER_URL, String(locale));
  }
});

test("the Cipher URLs point at sloga.gg over https", () => {
  assert.equal(CIPHER_URL, "https://sloga.gg/cipher/");
  assert.equal(CIPHER_URL_PT, "https://sloga.gg/pt-br/cipher/");
});

test("counts use the reader's digit grouping", () => {
  assert.equal(formatCount(1000, "en"), "1,000");
  assert.equal(formatCount(1000, "pt_BR"), "1.000");
  assert.equal(formatCount(675, "pt_BR"), "675");
});

test("an unknown locale key still prints the number", () => {
  assert.equal(formatCount(1000, "owo-not-a-locale-$$"), "1000");
});
