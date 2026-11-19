// Source pins for the shader texts in `cameraToneStage.ts`, run with Node's
// built-in runner from packages/client:
//   node --test --conditions=browser components/rtc/cameraToneStageSource.test.ts
// `node --test` cannot load `cameraToneStage.ts` (it needs a document and a
// WebGL2 context), so this file reads it as text.
//
// Two things are held here:
//  - the four shaders every call draws with (vertex, blur, plain final pass,
//    luma meter) are byte-for-byte what they were before the face-tracked
//    look was added. The look has its own final-pass shader; anyone with the
//    look off must get exactly the picture they got before, and the simplest
//    proof is that the shaders they run did not change. Each text is pinned
//    by its sha256. Changing one of them on purpose means replacing its hash
//    here, in the same change, with a reason;
//  - the look's shader and the code that feeds it agree on the uniform names.
//    A name looked up but not declared (or the reverse) compiles, links and
//    draws: `getUniformLocation` returns null and the `uniform*` call on it
//    is silently ignored, so the value stays 0 and part of the look is
//    missing with nothing logged. The same goes for the sizes of the warp
//    arrays, and for the scalar uniforms those arrays replaced.
//
// Known limits: the shader texts are found as `const NAME = \`...\`;`, and
// the lookups as `at("name")`. Renaming the constant or the `at` helper
// fails the tests that say so below, rather than passing with nothing read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const STAGE_SOURCE = readFileSync(
  new URL("./cameraToneStage.ts", import.meta.url),
  "utf8",
);

/** The text between the backticks of the ONE `const <name> = \`...\`;`. */
function templateText(source: string, name: string): string {
  const found = [
    ...source.matchAll(new RegExp("const " + name + " = `([^`]*)`;", "g")),
  ];
  assert.equal(
    found.length,
    1,
    `expected exactly one template literal named ${name}, found ${found.length}`,
  );
  return found[0][1];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * sha256 of each shader text as it was before the face-tracked look was
 * added (commit ee94780c), taken over the exact characters between the
 * backticks, `${LUMA_SIZE}` left as written.
 */
const PINNED = {
  VERTEX_SOURCE:
    "f8381565c249c3e26a279f24b13c61cae92faf75b1872f3e0c23620993d3c98c",
  BLUR_SOURCE:
    "b335c1123b6380c9cf848b4206255bbe974337b00137cf9b047223d50a7ff03d",
  FINAL_SOURCE:
    "0fc9598fb681d62a607e6a2aedcb6f390c93014d9daa6ca1b0b4fbe799839f8e",
  LUMA_SOURCE:
    "cf6713cd2141742234c7035c0e5c2cfe1acbc78388b025108e3df1a2694d7c09",
} as const;

for (const [name, expected] of Object.entries(PINNED)) {
  test(`${name} is byte-identical to the pinned text`, () => {
    const text = templateText(STAGE_SOURCE, name);
    assert.ok(
      text.startsWith("#version 300 es\n"),
      `${name} does not start like a shader: the extraction read something else`,
    );
    assert.equal(
      sha256(text),
      expected,
      `${name} changed. With the look off the picture must stay exactly as it was; ` +
        "if the change is intended, replace the hash here and say why.",
    );
  });
}

test("the look's shader and its uniform lookups name the same uniforms", () => {
  const glam = templateText(STAGE_SOURCE, "GLAM_SOURCE");
  const declared = [...glam.matchAll(/^uniform\s+\w+\s+(\w+)/gm)].map(
    (m) => m[1],
  );
  const lookedUp = [...STAGE_SOURCE.matchAll(/\bat\(\s*"(\w+)"\s*\)/g)].map(
    (m) => m[1],
  );

  // The lookups below are only the look's if `at` reads the look's program.
  const helpers = STAGE_SOURCE.split(
    "const at = (name: string) => gl.getUniformLocation(glam, name);",
  );
  assert.equal(
    helpers.length - 1,
    1,
    "expected exactly one `at` helper, bound to the look's program",
  );
  assert.ok(
    !/\bconst at\b/.test(helpers.join("")),
    "a second `at` helper would mix another program's lookups into this check",
  );

  // Guards against a scan that silently reads nothing.
  assert.ok(declared.length >= 19, `only ${declared.length} uniforms declared`);
  assert.ok(
    lookedUp.length >= 19,
    `only ${lookedUp.length} uniforms looked up`,
  );

  assert.deepEqual(
    [...new Set(declared)].sort(),
    [...declared].sort(),
    "a uniform is declared twice",
  );
  assert.deepEqual(
    [...new Set(lookedUp)].sort(),
    [...lookedUp].sort(),
    "a uniform is looked up twice",
  );
  assert.deepEqual(
    declared.filter((name) => !lookedUp.includes(name)),
    [],
    "declared in the shader but never looked up (its value would stay 0)",
  );
  assert.deepEqual(
    lookedUp.filter((name) => !declared.includes(name)),
    [],
    "looked up but not declared in the shader (the lookup returns null)",
  );
});

test("the look's warp arrays have the sizes the stage fills and uploads", () => {
  // An upload longer than the declared array leaves a GL error and switches
  // the look off; a shorter one leaves the last entries at 0, so a part of
  // the face silently stops moving. Sizes: three magnifies (two eyes, the
  // mouth), eight pushes (four jaw, two chin, two nose).
  const glam = templateText(STAGE_SOURCE, "GLAM_SOURCE");
  for (const declaration of [
    "uniform vec3 uMag[3];",
    "uniform float uMagAmt[3];",
    "uniform vec4 uPush[8];",
    "uniform float uPushR[8];",
    "uniform float uPushAmt[8];",
  ]) {
    assert.equal(
      glam.split("\n").filter((line) => line === declaration).length,
      1,
      `expected the shader to declare \`${declaration}\` once`,
    );
  }
  // Each loop walks its whole array, with a constant bound.
  assert.deepEqual(
    [...glam.matchAll(/for \(int i = 0; i < (\d+); i\+\+\)/g)].map((m) => m[1]),
    ["3", "8"],
    "the magnify loop runs 3 times and the push loop 8 times, in that order",
  );
  // The buffers behind the uploads: 3 x vec3, 3, 8 x vec4, 8, 8.
  for (const buffer of [
    "readonly #glamMag = new Float32Array(9);",
    "readonly #glamMagAmount = new Float32Array(3);",
    "readonly #glamPush = new Float32Array(32);",
    "readonly #glamPushRadius = new Float32Array(8);",
    "readonly #glamPushAmount = new Float32Array(8);",
  ]) {
    assert.equal(
      STAGE_SOURCE.split(buffer).length - 1,
      1,
      `expected the stage to hold \`${buffer}\` once`,
    );
  }
  for (const upload of [
    "gl.uniform3fv(uniforms.mag, this.#glamMag);",
    "gl.uniform1fv(uniforms.magAmount, this.#glamMagAmount);",
    "gl.uniform4fv(uniforms.push, this.#glamPush);",
    "gl.uniform1fv(uniforms.pushRadius, this.#glamPushRadius);",
    "gl.uniform1fv(uniforms.pushAmount, this.#glamPushAmount);",
  ]) {
    assert.equal(
      STAGE_SOURCE.split(upload).length - 1,
      1,
      `expected the stage to upload with \`${upload}\` once`,
    );
  }
});

test("the uniforms the warp arrays replaced are gone from the stage", () => {
  // `uEye`, `uSlim`, `uEyes`, `uJaw` and `uJawR` became the arrays above. One
  // left behind in the shader is an unused uniform; one left in a lookup
  // returns null and its upload is silently ignored.
  const leftovers = STAGE_SOURCE.match(/\bu(?:Eyes?|Slim|JawR?)\b/g) ?? [];
  assert.deepEqual(leftovers, [], "an old warp uniform is still named");
  // The scan above must be able to see a uniform name at all.
  assert.ok(/\buMag\b/.test(STAGE_SOURCE), "the scan found no warp uniform");
});

test("the look's shader is plain ASCII", () => {
  // A stray non-ASCII character outside a comment is a compile error on
  // some drivers and not on others.
  const glam = templateText(STAGE_SOURCE, "GLAM_SOURCE");
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7f]/.test(glam), "non-ASCII character in GLAM_SOURCE");
});
