// Spec for the Protected channel row in ServerSidebar.tsx (W4 lane C2, plan
// D14 and product choice 5), run with Node's built-in runner from
// packages/client:
//   node --conditions=browser --test src/interface/navigation/channels/protectedSidebar.scan.test.ts
//
// ServerSidebar.tsx imports Solid, the client context and the UI kit, so
// Node cannot load it. The name-tint rule sits in one marked region
// (`// protected-pure:begin` .. `// protected-pure:end`) with no imports;
// this spec cuts it out, strips the types with Node's own stripper and runs
// the real source against the real `shieldPresentation`. The wiring (which
// hook, which glyph, where the tint lands) is checked by scanning the file.
//
//  S1  tint only while attention is `normal` AND `tintName` (every state x
//      every attention, real `shieldPresentation`);
//  S2  the row reads the shield through `useProtectedShield` only: no
//      `useProtectedChannelOpen` and no other protected request here;
//  S3  the shield is the FIRST match of the row's glyph `<Switch>` (so it
//      takes the `edit` glyph's place), with `shieldLabel` as its title;
//  S4  the tint is fed the row's own `attentionState()` and lands as an
//      inline colour on the name only (no `--color` write in the row);
//  S5  the custom icon and the password lock are unchanged;
//  S6  blank-page traps: no `styled(<Component>` and the shield icon is
//      imported by file path.
//
// Point `PROTECTED_SIDEBAR_FILE` at another copy (a known-bad control) to
// check that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PROTECTED_SHIELD_STATES,
  shieldPresentation,
} from "../../../../components/client/protectedShield.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath =
  process.env.PROTECTED_SIDEBAR_FILE || join(here, "ServerSidebar.tsx");
const source = readFileSync(sourcePath, "utf8");

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

type Attention = "muted" | "normal" | "active" | "selected";
const ATTENTIONS: Attention[] = ["muted", "normal", "active", "selected"];
type Tint = (
  p: { tintName: boolean; hueVar: string } | null | undefined,
  a: Attention,
) => string | undefined;

async function loadTint(): Promise<Tint> {
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  assert.ok(from !== -1 && to > from, "protected-pure region missing");
  const region = source.slice(from, to);
  assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
  const js =
    stripTypeScriptTypes(region, { mode: "strip" }) +
    "\nexport { protectedNameTint };\n";
  const dir = mkdtempSync(join(tmpdir(), "w4c1-C2-"));
  const out = join(dir, "protectedSidebarPure.mjs");
  writeFileSync(out, js);
  const mod = (await import(pathToFileURL(out).href)) as Record<
    string,
    unknown
  >;
  assert.equal(
    typeof mod.protectedNameTint,
    "function",
    "protectedNameTint missing",
  );
  return mod.protectedNameTint as Tint;
}

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(source);

/** The `Entry` component body: from `function Entry(` to the next top-level declaration. */
function entryBody(): string {
  const from = CODE.indexOf("\nfunction Entry(");
  assert.ok(from !== -1, "function Entry missing");
  const rest = CODE.slice(from + 1);
  const next = rest.search(/\n(?:function |const |export |interface )/);
  assert.ok(next > 0, "end of Entry not found");
  return rest.slice(0, next);
}

const ENTRY = entryBody();

/** The row's glyph `<Switch>` (the one whose fallback is the `edit` glyph). */
function glyphSwitch(): string {
  const open = "<Switch fallback={<Symbol>edit</Symbol>}>";
  const from = ENTRY.indexOf(open);
  assert.ok(from !== -1, "the row glyph <Switch> is missing");
  assert.equal(
    ENTRY.indexOf(open, from + 1),
    -1,
    "more than one row glyph <Switch>",
  );
  const to = ENTRY.indexOf("</Switch>", from);
  assert.ok(to > from, "unterminated row glyph <Switch>");
  return ENTRY.slice(from, to);
}

const EXPECT_TINT = new Set(["protected", "not_available", "unverified"]);

describe("ServerSidebar Protected channel row (lane C2)", () => {
  it("S1 tints the name only while normal, and only for tinting states (C-C2a)", async () => {
    const tint = await loadTint();
    for (const state of PROTECTED_SHIELD_STATES) {
      const p = shieldPresentation(state);
      assert.equal(
        p.tintName,
        EXPECT_TINT.has(state),
        `D14 tint set changed for ${state}`,
      );
      for (const attention of ATTENTIONS) {
        const got = tint(p, attention);
        if (attention === "normal" && p.tintName) {
          assert.equal(
            got,
            `color-mix(in srgb, var(${p.hueVar}) 70%, var(--md-sys-color-on-surface))`,
            `${state}/${attention}`,
          );
        } else {
          assert.equal(got, undefined, `${state}/${attention} must not tint`);
        }
      }
    }
    for (const attention of ATTENTIONS) {
      assert.equal(tint(null, attention), undefined);
      assert.equal(tint(undefined, attention), undefined);
    }
    // Re-securing never tints, even while normal (F9: the orange is the
    // unread accent's neighbour).
    assert.equal(tint(shieldPresentation("resecuring"), "normal"), undefined);
  });

  it("S2 reads the shield read-only, never runs the open lifecycle (C-C2b)", () => {
    assert.doesNotMatch(
      CODE,
      /\buseProtectedChannelOpen\b/,
      "the sidebar must never use useProtectedChannelOpen",
    );
    for (const name of [
      "protectedOpen",
      "protectedClose",
      "readChannelProtectedFlag",
      "applyProtectedFlag",
      "decryptProtectedHistory",
      "useProtectedMessage",
      "useProtectedTimeline",
    ]) {
      assert.doesNotMatch(
        CODE,
        new RegExp(`\\b${name}\\b`),
        `${name} is not for the sidebar`,
      );
    }
    assert.match(
      CODE,
      /import \{ useProtectedShield \} from "@revolt\/client\/useProtectedChannel";/,
    );
    const calls = ENTRY.match(/\buseProtectedShield\s*\(/g) ?? [];
    assert.equal(calls.length, 1, "one useProtectedShield call in Entry");
    assert.match(ENTRY, /useProtectedShield\(\(\) => props\.channel\.id\)/);
    assert.equal(
      (CODE.match(/\buseProtectedShield\s*\(/g) ?? []).length,
      1,
      "no useProtectedShield outside the row",
    );
  });

  it("S3 the shield replaces the edit glyph, first match, labelled (C-C2c)", () => {
    const sw = glyphSwitch();
    const firstMatch = sw.indexOf("<Match");
    assert.ok(firstMatch !== -1, "no <Match> in the glyph switch");
    const first = sw.slice(firstMatch, sw.indexOf("</Match>", firstMatch));
    assert.match(first, /^<Match when=\{protectedState\(\)\}>/);
    assert.match(first, /<ProtectedShieldIcon\b/);
    assert.match(first, /state=\{state\(\)\}/);
    assert.match(first, /title=\{shieldLabel\(state\(\)\)\}/);
    assert.match(
      ENTRY,
      /const protectedState = \(\) => protectedShield\(\)\?\.state;/,
    );
    assert.equal(
      (CODE.match(/<ProtectedShieldIcon\b/g) ?? []).length,
      1,
      "one shield per row",
    );
    // The other glyphs are still there, after the shield.
    for (const g of ["props.channel.isVoice", '"Forum"', "isAnnouncement"]) {
      assert.ok(sw.indexOf(g) > firstMatch, `${g} match missing or first`);
    }
  });

  it("S4 the tint follows the row's attention and touches only the name", () => {
    assert.match(ENTRY, /attention=\{attentionState\(\)\}/);
    const memo = ENTRY.slice(ENTRY.indexOf("const protectedTint"));
    assert.ok(memo.length > 0, "protectedTint missing");
    assert.match(
      memo.slice(0, 300),
      /protectedNameTint\(\s*state \? shieldPresentation\(state\) : null,\s*attentionState\(\),\s*\)/,
    );
    assert.match(
      ENTRY,
      /<OverflowingText\s+style=\{protectedTint\(\) \? \{ color: protectedTint\(\) \} : undefined\}\s*>\s*<TextWithEmoji content=\{props\.channel\.name!\} \/>/,
    );
    assert.doesNotMatch(ENTRY, /--color/, "the row must not write --color");
    assert.equal(
      (CODE.match(/\bprotectedNameTint\(/g) ?? []).length,
      2,
      "defined once, called once",
    );
  });

  it("S5 the custom icon and the password lock are unchanged", () => {
    assert.match(
      ENTRY,
      /<\/Switch>\s*<Show when=\{props\.channel\.icon\}>\s*<ChannelIcon\s+src=\{props\.channel\.iconURL\}\s+css=\{\{ marginEnd: "0\.2em" \}\}\s*\/>\s*<\/Show>/,
    );
    assert.match(
      ENTRY,
      /<Show\s+when=\{\s*parseChannelPassword\(props\.channel\.description\)\.passwordHash\s*\}\s*>\s*<Symbol size=\{14\} style=\{\{ opacity: "0\.6" \}\}>\s*lock\s*<\/Symbol>\s*<\/Show>/,
    );
  });

  it("S6 no blank-page traps", () => {
    assert.doesNotMatch(CODE, /\bstyled\(\s*[A-Z]/, "styled(<Component>)");
    assert.match(
      CODE,
      /import \{ ProtectedShieldIcon \} from "@revolt\/ui\/components\/features\/protected\/ProtectedShieldIcon";/,
    );
  });
});
