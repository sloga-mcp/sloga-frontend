// Spec for the Encrypted-only offer under the Slim view choice
// (`slimEncryptedOnlyOffer.ts`), plus a source pin for its wiring in
// `SlimViewChoice.tsx`, which cannot load under Node. Run from
// packages/client:
//   node --test --conditions=browser \
//     components/app/interface/settings/user/appearance/slimEncryptedOnlyOffer.test.ts
// Declared test count: 3 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// `SLIM_OFFER_UNDER_TEST=<path>` loads another copy of the module and
// `SLIM_VIEW_CHOICE_TSX=<path>` scans another copy of the component (for
// failing controls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import type { OnlyAdvert } from "../../../../../modal/modals/encryptedOnlySetup.ts";

type Offer = typeof import("./slimEncryptedOnlyOffer.ts");

const override = process.env.SLIM_OFFER_UNDER_TEST;
const { slimOffersEncryptedOnly } = (await import(
  override
    ? pathToFileURL(resolve(override)).href
    : new URL("./slimEncryptedOnlyOffer.ts", import.meta.url).href
)) as Offer;

const BOOLS = [false, true];
const ADVERTS: (OnlyAdvert | null | undefined)[] = [
  undefined,
  null,
  { available: false, enforced: false },
  { available: false, enforced: true },
  { available: true, enforced: false },
  { available: true, enforced: true },
];

test("shown only in an app, advertised available, with the setting off", () => {
  let shown = 0;
  for (const app of BOOLS)
    for (const advert of ADVERTS)
      for (const userKnown of BOOLS)
        for (const latched of BOOLS)
          for (const serverOn of BOOLS)
            for (const settingUp of BOOLS) {
              const input = {
                app,
                advert,
                userKnown,
                latched,
                serverOn,
                settingUp,
              };
              const expected =
                app &&
                advert?.available === true &&
                userKnown &&
                !serverOn &&
                // A latch the server lost is the card's "turned off
                // elsewhere", not an offer
                (!latched || settingUp);
              assert.equal(
                slimOffersEncryptedOnly(input),
                expected,
                JSON.stringify(input),
              );
              if (expected) shown++;
            }
  // available x enforced(2) x (not latched x settingUp(2) + latched and
  // setting up(1))
  assert.equal(shown, 2 * 3);
});

test("never on the website, whatever the server says", () => {
  for (const advert of ADVERTS) {
    assert.equal(
      slimOffersEncryptedOnly({
        app: false,
        advert,
        userKnown: true,
        latched: false,
        serverOn: false,
        settingUp: false,
      }),
      false,
    );
  }
});

/** Source text without comments, so a comment cannot satisfy a pin. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

test("wiring: the advert is only asked for inside the app check", () => {
  const path = process.env.SLIM_VIEW_CHOICE_TSX;
  const choice = code(
    readFileSync(
      path ? resolve(path) : new URL("./SlimViewChoice.tsx", import.meta.url),
      "utf8",
    ),
  );

  const outerAt = choice.indexOf("function EncryptedOnlyOffer() {");
  const innerAt = choice.indexOf("function EncryptedOnlyOfferBody() {");
  assert.notEqual(outerAt, -1);
  assert.notEqual(innerAt, -1);
  assert.ok(outerAt < innerAt);
  const outer = choice.slice(outerAt, innerAt);
  const inner = choice.slice(innerAt);

  // The outer part mounts the body only in an app, and asks nothing itself
  assert.match(
    outer,
    /<Show when=\{deviceStateOf\(client\(\)\) !== "web"\}>\s*<EncryptedOnlyOfferBody \/>\s*<\/Show>/,
  );
  assert.equal(choice.split("useOnlyAdvert()").length - 1, 1);
  assert.doesNotMatch(outer, /useOnlyAdvert\(/);
  assert.match(inner, /const advert = useOnlyAdvert\(\);/);
  assert.equal(choice.split("<EncryptedOnlyOfferBody />").length - 1, 1);

  // The body shows by the helper's answer
  assert.match(
    inner,
    /const shown = createMemo\(\(\) =>\s*slimOffersEncryptedOnly\(\{/,
  );
  assert.match(inner, /<Show when=\{shown\(\)\}>/);
  assert.doesNotMatch(inner, /onlyCardState\(/);

  // No punctuation outside a translated string
  assert.doesNotMatch(choice, /<\/Trans>\s*[:;,.]/);
});
