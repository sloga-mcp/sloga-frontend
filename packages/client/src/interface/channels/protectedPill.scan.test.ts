// Spec for the Protected channel header pill and panel (W4 lane C3, plan
// D14, D15, D21; product choices 2, 3, 5, 6). `ProtectedChannelPill.tsx` and
// `ChannelHeader.tsx` cannot load under Node (Solid JSX, lingui, stoat.js),
// so this spec:
//
//  P1  loads the pill's pure block (between the `// --- pure: begin` and
//      `// --- pure: end` markers) through Node's type stripper, with A2's
//      real `shieldPresentation`, and checks its decisions: "Review owner
//      change" only for a pending SAME-user change; a null seat cap stays
//      unknown (never 0 / unlimited); the owner-pin line; the owner-device
//      re-create; the D14 name tint (never while re-securing);
//  P2  pins the D15 wiring: the review button sits directly under
//      `<Show when={reviewable()}>`, `reviewable` is the P1 predicate, and
//      the native dialog is reached only from a button click;
//  P3  pins the D21 wiring the same way (`recreateOffered`);
//  P4  pins the error path: A2 `protectedNoticeForError(..., { op: "owner" })`
//      + C0 `errorUiCopy`, never `error.message`;
//  P5  blank-page traps: every `styled(` takes a string tag; no barrel
//      import; the shield icon by file path;
//  P6  `ChannelHeader.tsx`: `grid_3x3` stays the fallback of a Show over the
//      read-only shield, the pill is mounted once in the text branch, the
//      name tint goes through the P1 helper.
//
// Run: node --test --conditions=browser \
//   src/interface/channels/protectedPill.scan.test.ts
// `PROTECTED_PILL_TSX=<path>` / `PROTECTED_CHANNELHEADER_TSX=<path>` scan
// other copies (named controls C-C3a/b/c).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_ROOT = resolve(HERE, "../../..");
const SHIELD_PATH = resolve(
  CLIENT_ROOT,
  "components/client/protectedShield.ts",
);

const PILL = readFileSync(
  process.env.PROTECTED_PILL_TSX || resolve(HERE, "ProtectedChannelPill.tsx"),
  "utf8",
);
const HEADER = readFileSync(
  process.env.PROTECTED_CHANNELHEADER_TSX || resolve(HERE, "ChannelHeader.tsx"),
  "utf8",
);

/** Drop block and whole-line comments so prose never counts as code. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PILL_CODE = code(PILL);
const HEADER_CODE = code(HEADER);

// ---- P1: the pure block ------------------------------------------------------

async function loadPure(): Promise<Record<string, unknown>> {
  const begin = PILL.indexOf("// --- pure: begin");
  const end = PILL.indexOf("// --- pure: end");
  assert.ok(begin >= 0 && end > begin, "pure block markers missing");
  const block = PILL.slice(begin, end);
  assert.doesNotMatch(block, /^\s*import\s/m, "pure block must not import");
  const js =
    `import { shieldPresentation } from ${JSON.stringify(
      pathToFileURL(SHIELD_PATH).href,
    )};\n` + stripTypeScriptTypes(block, { mode: "strip" });
  const dir = mkdtempSync(join(tmpdir(), "w4c1-C3-"));
  const out = join(dir, "pillPure.mjs");
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const pure = await loadPure();
function fn<T>(name: string): T {
  assert.equal(typeof pure[name], "function", `export ${name} missing`);
  return pure[name] as T;
}

type AnyView = Record<string, unknown> | null | undefined;
const reviewable = fn<(v: AnyView) => boolean>("pillOwnerChangeReviewable");
const seats =
  fn<(s: unknown) => { used: number; cap: number | null } | null>("pillSeats");
const ownerPin = fn<(v: AnyView) => string | null>("pillOwnerPin");
const recreate = fn<
  (
    v: AnyView,
    self: { userId?: string | null; deviceId?: string | null },
  ) => boolean
>("pillRecreateOffered");
const nameStyle = fn<
  (s: string | null | undefined) => { color: string } | undefined
>("protectedHeaderNameStyle");

function pinView(
  pin: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): AnyView {
  return {
    ownerChangePending: false,
    recreateAvailable: false,
    native: pin === null ? null : { owner_pin: pin, seat_list: null },
    ...extra,
  };
}

const signer = (same_user: boolean) => ({
  user_id: "U1",
  device_id: "D2",
  same_user,
  verified: false,
});

describe("P1 pure decisions", () => {
  it("D15: review only for a pending same-user owner change", () => {
    // pending (manager parked) + same user
    assert.equal(
      reviewable(
        pinView(
          { status: "changed", pending_signer: signer(true) },
          { ownerChangePending: true },
        ),
      ),
      true,
    );
    // native says changed + same user (not yet parked by the manager)
    assert.equal(
      reviewable(pinView({ status: "changed", pending_signer: signer(true) })),
      true,
    );
    // different user: final in S1, never a button
    assert.equal(
      reviewable(
        pinView(
          { status: "changed", pending_signer: signer(false) },
          { ownerChangePending: true },
        ),
      ),
      false,
    );
    // pending but the signer is unknown: no button
    assert.equal(
      reviewable(
        pinView(
          { status: "changed", pending_signer: null },
          { ownerChangePending: true },
        ),
      ),
      false,
    );
    assert.equal(
      reviewable(pinView(null, { ownerChangePending: true })),
      false,
    );
    // same user recorded but nothing pending
    assert.equal(
      reviewable(pinView({ status: "pinned", pending_signer: signer(true) })),
      false,
    );
    assert.equal(reviewable(null), false);
    assert.equal(reviewable(undefined), false);
  });

  it("seats: a null cap is unknown, never 0 or unlimited", () => {
    const base = { seats_used: 4, slot_cap: 10 };
    assert.deepEqual(seats(base), { used: 4, cap: 10 });
    assert.deepEqual(seats({ ...base, slot_cap: null }), {
      used: 4,
      cap: null,
    });
    assert.deepEqual(seats({ ...base, slot_cap: 0 }), { used: 4, cap: null });
    assert.deepEqual(seats({ ...base, slot_cap: Number.NaN }), {
      used: 4,
      cap: null,
    });
    assert.deepEqual(seats({ ...base, slot_cap: "10" }), {
      used: 4,
      cap: null,
    });
    assert.deepEqual(seats({ seats_used: 0, slot_cap: 3 }), {
      used: 0,
      cap: 3,
    });
    assert.equal(seats(null), null);
    assert.equal(seats(undefined), null);
    assert.equal(seats({ ...base, seats_used: -1 }), null);
    assert.equal(seats({ ...base, seats_used: null }), null);
    assert.equal(seats({ ...base, seats_used: 1.5 }), null);
  });

  it("owner pin: verified only with the pin AND owner_verified", () => {
    assert.equal(
      ownerPin(pinView({ status: "pinned", owner_verified: true })),
      "pinned",
    );
    assert.equal(
      ownerPin(pinView({ status: "pinned", owner_verified: false })),
      "unpinned",
    );
    assert.equal(
      ownerPin(pinView({ status: "unpinned", owner_verified: false })),
      "unpinned",
    );
    assert.equal(ownerPin(pinView(null)), "unpinned");
    assert.equal(ownerPin(null), "unpinned");
    assert.equal(
      ownerPin(
        pinView(
          { status: "changed", pending_signer: signer(true) },
          { ownerChangePending: true },
        ),
      ),
      "changed",
    );
    // not reviewable: the state notice explains it, no "review" line
    assert.equal(
      ownerPin(pinView({ status: "changed", pending_signer: signer(false) })),
      null,
    );
  });

  it("D21: re-create only when stranded AND this device signed", () => {
    const list = {
      signer_user_id: "U1",
      signer_device_id: "D1",
    };
    const v = (recreateAvailable: boolean, seat_list: unknown) => ({
      recreateAvailable,
      ownerChangePending: false,
      native: { seat_list, owner_pin: null },
    });
    const self = { userId: "U1", deviceId: "D1" };
    assert.equal(recreate(v(true, list), self), true);
    assert.equal(recreate(v(false, list), self), false);
    assert.equal(recreate(v(true, null), self), false);
    assert.equal(
      recreate(v(true, list), { userId: "U1", deviceId: "D9" }),
      false,
    );
    assert.equal(
      recreate(v(true, list), { userId: "U9", deviceId: "D1" }),
      false,
    );
    assert.equal(
      recreate(v(true, list), { userId: "U1", deviceId: null }),
      false,
    );
    assert.equal(recreate(v(true, list), {}), false);
    assert.equal(recreate(null, self), false);
  });

  it("D14 name tint: never without a shield or while re-securing", () => {
    assert.equal(nameStyle(undefined), undefined);
    assert.equal(nameStyle(null), undefined);
    assert.equal(nameStyle("resecuring"), undefined);
    assert.equal(nameStyle("not_seated"), undefined);
    assert.equal(
      nameStyle("protected")?.color,
      "color-mix(in srgb, var(--sloga-protected-ok) 70%, var(--md-sys-color-on-surface))",
    );
    assert.match(nameStyle("unverified")!.color, /--sloga-protected-alert/);
    assert.match(
      nameStyle("not_available")!.color,
      /--sloga-protected-unavailable/,
    );
  });
});

// ---- Source helpers ----------------------------------------------------------

/** The last `<Show ...>` opener before `index`, and whether it is unclosed. */
function enclosingShow(src: string, index: number): string | null {
  const before = src.slice(0, index);
  const open = before.lastIndexOf("<Show");
  if (open < 0) return null;
  if (before.indexOf("</Show>", open) >= 0) return null;
  const close = src.indexOf(">", open);
  return src.slice(open, close + 1);
}

function count(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

/** Body of `async function run(` up to its matching brace. */
function runBody(src: string): string {
  const start = src.indexOf("async function run(");
  assert.ok(start >= 0, "run() missing");
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("run() body not closed");
}

// ---- P2 / P3: D15 and D21 wiring --------------------------------------------

describe("P2 D15 review wiring", () => {
  it("the button sits directly under <Show when={reviewable()}>", () => {
    const at = PILL_CODE.indexOf("panelCopy.reviewOwnerChange()");
    assert.ok(at >= 0, "review button copy missing");
    assert.equal(
      count(PILL_CODE, /panelCopy\.reviewOwnerChange\(\)/g),
      1,
      "one review button",
    );
    assert.equal(enclosingShow(PILL_CODE, at), "<Show when={reviewable()}>");
  });

  it("reviewable is the capable-gated P1 predicate", () => {
    assert.match(
      PILL_CODE,
      /const reviewable = \(\) =>\s*full\(\) && pillOwnerChangeReviewable\(view\(\)\);/,
    );
    assert.match(
      PILL_CODE,
      /const full = \(\) => shield\(\)\?\.capable === true;/,
    );
  });

  it("native dialogs only from a button click", () => {
    const body = runBody(PILL_CODE);
    for (const m of ["confirmOwnerChange", "recreateGroup"]) {
      // `panelCopy.recreateGroup()` is the button label, not the bridge call.
      const re = `(?<!panelCopy\\.)\\b${m}\\b`;
      assert.equal(
        count(PILL_CODE, new RegExp(re, "g")),
        1,
        `${m} referenced once`,
      );
      assert.match(body, new RegExp(re), `${m} only inside run()`);
    }
    const calls = PILL_CODE.match(/\brun\("(review|recreate)"\)/g) ?? [];
    assert.equal(calls.length, 2, "two run() call sites");
    assert.equal(
      count(PILL_CODE, /onClick=\{\(\) => void run\("(review|recreate)"\)\}/g),
      2,
      "both from onClick",
    );
    assert.doesNotMatch(PILL_CODE, /\bonMount\s*\(/);
  });
});

describe("P3 D21 re-create wiring", () => {
  it("the button sits directly under <Show when={recreateOffered()}>", () => {
    const at = PILL_CODE.indexOf("panelCopy.recreateGroup()");
    assert.ok(at >= 0, "re-create copy missing");
    assert.equal(
      enclosingShow(PILL_CODE, at),
      "<Show when={recreateOffered()}>",
    );
    assert.match(
      PILL_CODE,
      /const recreateOffered = \(\) =>\s*full\(\) &&\s*pillRecreateOffered\(view\(\),/,
    );
  });

  it("no handover UI (choice 3)", () => {
    assert.doesNotMatch(PILL_CODE, /handover/i);
  });
});

// ---- P4: errors ---------------------------------------------------------------

describe("P4 error path", () => {
  it("A2 + C0 only, never error.message", () => {
    const body = runBody(PILL_CODE);
    assert.match(
      body,
      /protectedNoticeForError\(error, \{ op: "owner" \}\)/,
      "object ctx, op owner",
    );
    assert.match(body, /errorUiCopy\(answer\)/);
    assert.doesNotMatch(PILL_CODE, /\.message\b/);
    assert.doesNotMatch(PILL_CODE, /String\(error\)/);
  });

  it("seat line never invents a cap", () => {
    assert.doesNotMatch(PILL_CODE, /slot_cap\s*(\?\?|\|\|)/);
    assert.doesNotMatch(PILL_CODE, /unlimited|Infinity/i);
    assert.match(
      PILL_CODE,
      /if \(s\.cap !== null\) return panelCopy\.seatsUsed\(s\.used, s\.cap\);/,
    );
  });
});

// ---- P5: blank-page traps ------------------------------------------------------

describe("P5 blank-page traps", () => {
  it("every styled( takes a string tag", () => {
    const calls = [...PILL_CODE.matchAll(/\bstyled\(\s*([^,)\s]+)/g)];
    assert.ok(calls.length > 0, "no styled( call found (vacuous)");
    for (const c of calls) {
      assert.match(c[1], /^"[a-z]+"$/, `styled(${c[1]} is not a string tag`);
    }
  });

  it("no barrel imports; the shield icon by file path", () => {
    const specs = [...PILL_CODE.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(specs.length > 0);
    for (const s of specs) {
      assert.ok(
        !["@revolt/ui", "@revolt/app", "@revolt/common", "."].includes(s) &&
          !/^(\.\.\/)+$|\/$/.test(s) &&
          !/^@revolt\/ui\/components(\/features)?$/.test(s),
        `barrel import ${s}`,
      );
    }
    assert.ok(
      specs.includes(
        "@revolt/ui/components/features/protected/ProtectedShieldIcon",
      ),
    );
  });
});

// ---- P6: ChannelHeader ---------------------------------------------------------

describe("P6 ChannelHeader", () => {
  it("grid_3x3 is the fallback of a Show over the shield", () => {
    assert.match(
      HEADER_CODE,
      /<Show when=\{protectedShield\(\)\} fallback=\{<Symbol>grid_3x3<\/Symbol>\}>/,
    );
    assert.equal(count(HEADER_CODE, /grid_3x3/g), 1);
    assert.equal(count(HEADER_CODE, /\buseProtectedShield\(/g), 1);
    assert.match(
      HEADER_CODE,
      /const protectedShield = useProtectedShield\(\(\) => props\.channel\.id\);/,
    );
  });

  it("the pill is mounted once, after the name, in the text branch", () => {
    assert.equal(count(HEADER_CODE, /<ProtectedChannelPill\b/g), 1);
    const pill = HEADER_CODE.indexOf(
      "<ProtectedChannelPill channel={props.channel} />",
    );
    const name = HEADER_CODE.indexOf(
      "style={protectedHeaderNameStyle(protectedShield()?.state)}",
    );
    const grid = HEADER_CODE.indexOf("grid_3x3");
    const dm = HEADER_CODE.indexOf('props.channel.type === "DirectMessage"');
    assert.ok(name > grid && pill > name && pill < dm, "pill placement");
  });

  it("imports the pill and icon by file path", () => {
    assert.match(HEADER_CODE, /from "\.\/ProtectedChannelPill";/);
    assert.match(
      HEADER_CODE,
      /from "@revolt\/ui\/components\/features\/protected\/ProtectedShieldIcon";/,
    );
    assert.match(HEADER_CODE, /from "@revolt\/client\/useProtectedChannel";/);
  });
});
