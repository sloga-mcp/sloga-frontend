// Specs for name styling precedence — run with Node's built-in runner:
//   node --conditions=browser --test components/common/lib/nameLayers.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import type { NameStyle } from "stoat.js";

import { resolveNameLayers } from "./nameLayers.ts";

const FULL: NameStyle = { colour: "#ff00aa", font: "Pixel", effect: "Glow" };
const ROLE = "linear-gradient(90deg, red, blue)";

test("masquerade wins over everything and drops font and effect", () => {
  assert.deepEqual(
    resolveNameLayers({
      masquerade: true,
      brand: true,
      roleColour: ROLE,
      style: FULL,
    }),
    { mode: "plain" },
  );
  assert.deepEqual(resolveNameLayers({ masquerade: true, style: FULL }), {
    mode: "plain",
  });
});

test("brand beats role and personal color but keeps font and effect", () => {
  assert.deepEqual(
    resolveNameLayers({ brand: true, roleColour: ROLE, style: FULL }),
    { mode: "brand", style: { font: "Pixel", effect: "Glow" } },
  );
  assert.deepEqual(
    resolveNameLayers({ brand: true, style: { colour: "#123456" } }),
    { mode: "brand" },
  );
});

test("role color beats personal color; font and effect still apply", () => {
  assert.deepEqual(resolveNameLayers({ roleColour: ROLE, style: FULL }), {
    mode: "styled",
    colour: ROLE,
    style: { font: "Pixel", effect: "Glow" },
  });
});

test("personal color applies when there is no role color", () => {
  for (const roleColour of [undefined, null, ""]) {
    assert.deepEqual(resolveNameLayers({ roleColour, style: FULL }), {
      mode: "styled",
      colour: "#ff00aa",
      style: { font: "Pixel", effect: "Glow" },
    });
  }
});

test("fallback color loses to role and personal color", () => {
  const VIOLET = "#8B5CF6";
  assert.equal(
    resolveNameLayers({ roleColour: ROLE, style: FULL, fallbackColour: VIOLET })
      .colour,
    ROLE,
  );
  assert.equal(
    resolveNameLayers({ style: FULL, fallbackColour: VIOLET }).colour,
    "#ff00aa",
  );
  for (const roleColour of [undefined, null, ""]) {
    assert.deepEqual(
      resolveNameLayers({
        roleColour,
        style: { font: "Serif" },
        fallbackColour: VIOLET,
      }),
      { mode: "styled", colour: VIOLET, style: { font: "Serif" } },
    );
  }
});

test("masquerade and brand ignore the fallback color", () => {
  assert.deepEqual(
    resolveNameLayers({ masquerade: true, fallbackColour: "#8B5CF6" }),
    { mode: "plain" },
  );
  assert.deepEqual(
    resolveNameLayers({ brand: true, fallbackColour: "#8B5CF6" }),
    { mode: "brand" },
  );
});

test("role color alone, with no personal style", () => {
  assert.deepEqual(resolveNameLayers({ roleColour: ROLE }), {
    mode: "styled",
    colour: ROLE,
  });
});

test("font or effect alone is carried without the other", () => {
  assert.deepEqual(resolveNameLayers({ style: { font: "Serif" } }), {
    mode: "styled",
    style: { font: "Serif" },
  });
  assert.deepEqual(resolveNameLayers({ style: { effect: "Rainbow" } }), {
    mode: "styled",
    style: { effect: "Rainbow" },
  });
});

test("empty inputs give an unstyled name with no undefined keys", () => {
  for (const input of [
    {},
    { style: {} },
    { roleColour: null, style: {} },
    { masquerade: false, brand: false },
  ]) {
    const layers = resolveNameLayers(input);
    assert.deepEqual(layers, { mode: "styled" });
    assert.deepEqual(Object.keys(layers), ["mode"]);
  }
  assert.deepEqual(Object.keys(resolveNameLayers({ brand: true })), ["mode"]);
});

test("the input style is not mutated or aliased", () => {
  const style: NameStyle = { ...FULL };
  const layers = resolveNameLayers({ style });
  assert.deepEqual(style, FULL);
  assert.notEqual(layers.style, style);
});
