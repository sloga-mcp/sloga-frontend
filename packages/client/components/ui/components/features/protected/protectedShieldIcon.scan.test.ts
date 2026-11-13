// Spec for ProtectedShieldIcon.tsx (W4 plan D14; S2 lane U5, D35
// `capacity`), run with Node's built-in runner from packages/client:
//   node --conditions=browser --test components/ui/components/features/protected/protectedShieldIcon.scan.test.ts
//
// The icon imports Solid and the styled-system, so Node cannot load it. It
// has no logic of its own: glyph and hue come from the real, exhaustive
// `shieldPresentation`, which this spec runs; the wiring is checked by
// scanning the file with comments removed (prose never counts).
//
//  I1  glyph and hue come only from `shieldPresentation(props.state,
//      { tauriE2eeOff })`, rendered as given (no literal glyph or hue);
//  I2  the icon never names or compares a shield state, so no state can
//      get a placeholder arm here; an unknown state fails loud;
//  I3  every shield state (keys must be exactly `PROTECTED_SHIELD_STATES`)
//      renders a known glyph and a hue defined in `LoadTheme.tsx`, and
//      `tauriE2eeOff` never changes either;
//  I4  capacity (S2 D35) is the neutral shield: not the alert, not green;
//  I5  static in every state: no animation, no transition;
//  I6  blank-page traps: string-tag `styled` only, file-path imports.
//
// Point `PROTECTED_SHIELD_ICON_FILE` at another copy (a known-bad control)
// to check that instead; it must fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  type ProtectedShieldState,
  PROTECTED_SHIELD_STATES,
  shieldPresentation,
} from "../../../../client/protectedShield.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath =
  process.env.PROTECTED_SHIELD_ICON_FILE ||
  join(here, "ProtectedShieldIcon.tsx");
const source = readFileSync(sourcePath, "utf8");
const THEME = readFileSync(join(here, "../../../themes/LoadTheme.tsx"), "utf8");

/** Drop block and whole-line comments so prose never counts as code. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(source);

function count(re: RegExp): number {
  return (CODE.match(new RegExp(re.source, "g")) ?? []).length;
}

/**
 * What the icon renders per state. Keys must be exactly
 * `PROTECTED_SHIELD_STATES` (I3), so a state added there without a decision
 * here is red.
 */
const ICON: Record<string, { glyph: string; hue: string }> = {
  protected: { glyph: "verified_user", hue: "--sloga-protected-ok" },
  resecuring: { glyph: "shield", hue: "--sloga-protected-resecuring" },
  not_seated: { glyph: "shield", hue: "--sloga-protected-unavailable" },
  capacity: { glyph: "shield", hue: "--sloga-protected-unavailable" },
  not_available: {
    glyph: "remove_moderator",
    hue: "--sloga-protected-unavailable",
  },
  unverified: { glyph: "gpp_bad", hue: "--sloga-protected-alert" },
  grace: { glyph: "verified_user", hue: "--sloga-protected-grace" },
  frozen: { glyph: "shield", hue: "--sloga-protected-frozen" },
};

describe("ProtectedShieldIcon (S2 lane U5)", () => {
  it("I1 glyph and hue come only from shieldPresentation, rendered as given", () => {
    assert.equal(
      count(/\bshieldPresentation\(/),
      1,
      "exactly one shieldPresentation call",
    );
    assert.match(
      CODE,
      /shieldPresentation\(\s*props\.state,\s*\{\s*tauriE2eeOff:\s*props\.tauriE2eeOff\s*\}\s*\)/,
      "the state and tauriE2eeOff go to shieldPresentation unchanged",
    );
    assert.equal(count(/<Symbol\b/), 1, "exactly one glyph");
    assert.match(
      CODE,
      /<Symbol>\{presentation\(\)\.glyph\}<\/Symbol>/,
      "the glyph is presentation().glyph",
    );
    assert.match(
      CODE,
      /color:\s*`var\(\$\{presentation\(\)\.hueVar\}\)`/,
      "the hue is var(presentation().hueVar)",
    );
    assert.doesNotMatch(CODE, /--sloga-protected-/, "no literal hue variable");
    for (const glyph of new Set(Object.values(ICON).map((v) => v.glyph))) {
      for (const [l, r] of [
        ['"', '"'],
        ["'", "'"],
        ["`", "`"],
        [">", "<"],
      ]) {
        assert.ok(
          !CODE.includes(`${l}${glyph}${r}`),
          `the icon names the ${glyph} glyph: it belongs in shieldPresentation`,
        );
      }
    }
  });

  it("I2 the icon never names or compares a shield state; an unknown state fails loud", () => {
    for (const state of PROTECTED_SHIELD_STATES) {
      for (const q of ['"', "'", "`"]) {
        assert.ok(
          !CODE.includes(`${q}${state}${q}`),
          `the icon names the ${state} state: the arm belongs in shieldPresentation`,
        );
      }
    }
    assert.doesNotMatch(CODE, /props\.state\s*[!=]==?/, "no state comparison");
    assert.doesNotMatch(CODE, /\bswitch\s*\(/, "no switch");
    assert.doesNotMatch(CODE, /<(?:Match|Switch|Show)\b/, "no state branch");
    // read twice: the shieldPresentation argument and the data attribute
    assert.equal(count(/props\.state\b/), 2, "props.state read only twice");
    assert.match(CODE, /data-protected-shield=\{props\.state\}/);
    assert.throws(
      () => shieldPresentation("limbo" as unknown as ProtectedShieldState),
      /unknown protected shield state/,
    );
  });

  it("I3 every shield state renders a known glyph and a themed hue; tauriE2eeOff never changes them", () => {
    assert.deepEqual(
      Object.keys(ICON).sort(),
      [...PROTECTED_SHIELD_STATES].sort(),
      "the icon table must cover exactly PROTECTED_SHIELD_STATES",
    );
    assert.ok(
      PROTECTED_SHIELD_STATES.includes("capacity"),
      "S2 D35 capacity state missing",
    );
    for (const state of PROTECTED_SHIELD_STATES) {
      for (const tauriE2eeOff of [undefined, false, true]) {
        const p = shieldPresentation(state, { tauriE2eeOff });
        assert.equal(p.glyph, ICON[state].glyph, `${state}/${tauriE2eeOff}`);
        assert.equal(p.hueVar, ICON[state].hue, `${state}/${tauriE2eeOff}`);
      }
      const hue = ICON[state].hue;
      assert.match(
        THEME,
        new RegExp(`"${hue}":\\s*"#[0-9A-Fa-f]{6}"`),
        `${hue} (${state}) is not defined in LoadTheme.tsx`,
      );
    }
  });

  it("I4 capacity (S2 D35) is the neutral shield: not the alert, not green", () => {
    const cap = shieldPresentation("capacity");
    const red = shieldPresentation("unverified");
    const green = shieldPresentation("protected");
    assert.equal(cap.glyph, "shield", "capacity glyph");
    assert.equal(cap.hueVar, "--sloga-protected-unavailable", "capacity hue");
    assert.notEqual(cap.glyph, red.glyph, "capacity shows the alert glyph");
    assert.notEqual(cap.hueVar, red.hueVar, "capacity shows the alert hue");
    assert.notEqual(cap.glyph, green.glyph, "capacity shows the green glyph");
    assert.notEqual(cap.hueVar, green.hueVar, "capacity shows the green hue");
  });

  it("I5 static in every state: no animation, no transition", () => {
    assert.equal(count(/\banimation\s*:/), 1, "one animation key");
    assert.match(CODE, /\banimation:\s*"none"/);
    assert.equal(count(/\btransition\s*:/), 1, "one transition key");
    assert.match(CODE, /\btransition:\s*"none"/);
    assert.doesNotMatch(CODE, /keyframes|animationName|@keyframes/);
  });

  it("I6 blank-page traps: string-tag styled only, file-path imports", () => {
    assert.match(CODE, /const Shield = styled\("span", \{/);
    assert.doesNotMatch(
      CODE,
      /\bstyled\(\s*[A-Za-z_$]/,
      "styled() over a component",
    );
    assert.doesNotMatch(CODE, /use:floating/);
    assert.doesNotMatch(
      CODE,
      /from "@revolt\/ui"/,
      "the @revolt/ui barrel (import cycle)",
    );
    assert.match(CODE, /import \{ Symbol \} from "\.\.\/\.\.\/utils\/Symbol";/);
    assert.match(
      CODE,
      /from "\.\.\/\.\.\/\.\.\/\.\.\/client\/protectedShield";/,
    );
  });
});
