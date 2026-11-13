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
//      `<Show when={reviewable()}>`, `reviewable` is the P1 predicate (AND
//      F1's offer), the button opens the S2 D41 owner-review screen (never
//      `confirmOwnerChange` here), and native dialogs are reached only from
//      a button click;
//  P3  pins the D21 wiring the same way (`recreateOffered`);
//  P4  pins the error path: A2 `protectedNoticeForError(..., { op: "owner" })`
//      + C0 `errorUiCopy`, never `error.message`;
//  P5  blank-page traps: every `styled(` takes a string tag; no barrel
//      import; the shield icon by file path; `use:floating` sits on the
//      NATIVE pill button (a directive on a styled() component is dead);
//  P6  `ChannelHeader.tsx`: `grid_3x3` stays the fallback of a Show over the
//      read-only shield, the pill is mounted once in the text branch, the
//      name tint goes through the P1 helper;
//  P7  S2 (W4-3 lane U2), pure: Review needs F1's `reviewOffered === true`;
//      the panel details per state (capacity keeps them, the client-outdated
//      `not_available` drops them); the owner alert; owner-notice names
//      (never an id, all-or-nothing); the lost-signer line and the recover
//      offer (owner user, ANOTHER device); the D36 escalation (amber only,
//      only once escalated, only while `resecuring`);
//  P8  S2 wiring: the alert banner is never dismissible; the copy gets the
//      channel NAME; Recover / Review / retry only from clicks; the D36
//      read is guarded and timed; the owner notice goes through the P7
//      helper and the own device listing.
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
const ownerPin =
  fn<(v: AnyView, offered?: unknown) => string | null>("pillOwnerPin");
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
    // S2 F1: the "changed" line only while Review is offered
    assert.equal(
      ownerPin(
        pinView(
          { status: "changed", pending_signer: signer(true) },
          { ownerChangePending: true },
        ),
        true,
      ),
      "changed",
    );
    // not reviewable: the state notice explains it, no "review" line
    assert.equal(
      ownerPin(
        pinView({ status: "changed", pending_signer: signer(false) }),
        true,
      ),
      null,
    );
    // reviewable but the shield withholds Review (unlisted, OR-10): no line
    for (const offered of [false, undefined, "true", 1]) {
      assert.equal(
        ownerPin(
          pinView(
            { status: "changed", pending_signer: signer(true) },
            { ownerChangePending: true },
          ),
          offered,
        ),
        null,
        `offered ${String(offered)}`,
      );
    }
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

  it("reviewable is the capable-gated P1 predicate AND F1's offer", () => {
    // S2 F1 (pin updated from `full() && pillOwnerChangeReviewable(view())`):
    // `pillReviewOffered` = the D15 predicate && `reviewOffered === true`.
    assert.match(
      PILL_CODE,
      /const reviewable = \(\) =>\s*full\(\) && pillReviewOffered\(view\(\), shield\(\)\?\.reviewOffered\);/,
    );
    assert.match(
      PILL_CODE,
      /const ownerPin = \(\) => pillOwnerPin\(view\(\), shield\(\)\?\.reviewOffered\);/,
    );
    assert.match(
      PILL_CODE,
      /const full = \(\) => shield\(\)\?\.capable === true;/,
    );
  });

  it("native dialogs only from a button click", () => {
    const body = runBody(PILL_CODE);
    for (const m of ["recreateGroup", "recoverOwnership"]) {
      // `panelCopy.recreateGroup()` / `panelCopy.recoverOwnership()` are
      // button labels, not bridge calls.
      const re = `(?<!panelCopy\\.)\\b${m}\\b`;
      assert.equal(
        count(PILL_CODE, new RegExp(re, "g")),
        1,
        `${m} referenced once`,
      );
      assert.match(body, new RegExp(re), `${m} only inside run()`);
    }
    // S2 D41 (pins updated): Review opens the U7 review screen, which runs
    // `confirmOwnerChange`; Recover joined Re-create as a run() op.
    const calls = PILL_CODE.match(/\brun\("(review|recreate|recover)"\)/g);
    assert.equal(calls?.length, 2, "two run() call sites");
    assert.equal(
      count(PILL_CODE, /onClick=\{\(\) => void run\("(recreate|recover)"\)\}/g),
      2,
      "both from onClick",
    );
    assert.doesNotMatch(PILL_CODE, /\bonMount\s*\(/);
  });

  it("Review opens the owner-review screen, never the bridge directly", () => {
    assert.doesNotMatch(PILL_CODE, /\bconfirmOwnerChange\b/);
    const at = PILL_CODE.indexOf("onClick={() => openOwnerReview()}");
    assert.ok(at >= 0, "review button does not open the review screen");
    assert.equal(enclosingShow(PILL_CODE, at), "<Show when={reviewable()}>");
    assert.equal(count(PILL_CODE, /(?<!function )\bopenOwnerReview\(\)/g), 1);
    assert.match(
      PILL_CODE,
      /openModal\(\{\s*type: "protected_owner_review",\s*channel: props\.channel,\s*\} as unknown as ModalRequest\);/,
    );
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

  it("use:floating sits on the native pill button (S1 final F1)", () => {
    // On a styled() component the directive is a dead prop (the panel never
    // opened); see useOnStyled.scan.test.ts for the tree-wide rule.
    assert.match(
      PILL_CODE,
      /<button\s+class=\{pillClass\}[^>]*?\suse:floating=\{\{/,
    );
    assert.match(PILL_CODE, /const pillClass = css\(\{/);
    assert.doesNotMatch(PILL_CODE, /<Pill\b/);
    assert.equal(count(PILL_CODE, /\buse:floating=/g), 1);
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

// ---- P7: S2 pure decisions (W4-3 lane U2) ------------------------------------

type Self = { userId?: string | null; deviceId?: string | null };
const reviewOffered =
  fn<(v: AnyView, offered: unknown) => boolean>("pillReviewOffered");
const showsDetails = fn<(s: string) => boolean>("pillShowsDetails");
const ownerAlert = fn<(v: AnyView) => boolean>("pillOwnerAlert");
const displayName =
  fn<(name: unknown, id: string) => string | null>("pillDisplayName");
const seatedNames =
  fn<(ids: unknown, userName: (id: string) => string | null) => unknown>(
    "pillSeatedNames",
  );
const noticeDisplay = fn<(n: unknown, ctx: Record<string, unknown>) => unknown>(
  "pillOwnerNoticeDisplay",
);
const signerLost = fn<(v: AnyView) => string | null>("pillSignerLost");
const recover = fn<(v: AnyView, self: Self) => boolean>("pillRecoverOffered");
const escalation =
  fn<(s: string | null, r: unknown) => { note: unknown; action: unknown }>(
    "pillEscalation",
  );
const recreate3 = recreate as (v: AnyView, s: Self, e: boolean) => boolean;
const deviceCap = fn<(s: string | null, n: string | null) => boolean>(
  "pillDeviceCapOffered",
);

const SHIELD_STATES = [
  "protected",
  "resecuring",
  "not_seated",
  "capacity",
  "not_available",
  "unverified",
  "grace",
  "frozen",
];

const lostView = (l: unknown): AnyView => ({
  native: null,
  serverGroup: { signer_lost: l },
});

const lost = (over: Record<string, unknown> = {}) => ({
  user_id: "U1",
  device_id: "D-LOST",
  cause: "device_revoked",
  at: "2026-11-12T00:00:00Z",
  ...over,
});

const NAMES: Record<string, string> = {
  U2: "Ana",
  U3: "Bo",
  // a "name" that is the id itself: never shown
  U4: "U4",
};
const userName = (id: string) => NAMES[id] ?? null;
const deviceName = (id: string) =>
  id === "D-LAPTOP" ? "Laptop" : id === "D-SELFNAMED" ? "D-SELFNAMED" : null;

const notice = (kind: string, over: Record<string, unknown> = {}) => ({
  kind,
  device_id: "D-LAPTOP",
  seated: [],
  ...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
  channel: "general",
  alertShown: false,
  deviceName,
  userName,
  ...over,
});

const esc = (cause: string, escalated: boolean, action: string | null) => ({
  cause,
  escalateAtMs: 1,
  escalated,
  action,
});

describe("P7 S2 pure decisions (U2)", () => {
  it("F1: Review needs reviewOffered === true on top of D15", () => {
    const changed = pinView(
      { status: "changed", pending_signer: signer(true) },
      { ownerChangePending: true },
    );
    assert.equal(reviewOffered(changed, true), true);
    for (const offered of [false, undefined, null, "true", 1]) {
      assert.equal(reviewOffered(changed, offered), false, String(offered));
    }
    // the D15 precondition still binds: a different user never gets Review
    assert.equal(
      reviewOffered(
        pinView(
          { status: "changed", pending_signer: signer(false) },
          { ownerChangePending: true },
        ),
        true,
      ),
      false,
    );
    assert.equal(reviewOffered(null, true), false);
  });

  it("details per state: capacity keeps them, not_available drops them", () => {
    const want: Record<string, boolean> = {
      protected: true,
      resecuring: true,
      not_seated: true,
      capacity: true,
      unverified: true,
      not_available: false,
      grace: false,
      frozen: false,
    };
    for (const s of SHIELD_STATES) {
      assert.equal(showsDetails(s), want[s], s);
    }
  });

  it("D38: the device-cap screen only for capacity device_cap", () => {
    assert.equal(deviceCap("capacity", "capacity_device_cap"), true);
    // a full group: no device of this account to sign out
    assert.equal(deviceCap("capacity", "capacity_group_full"), false);
    assert.equal(deviceCap("capacity", null), false);
    for (const s of SHIELD_STATES.filter((x) => x !== "capacity")) {
      assert.equal(deviceCap(s, "capacity_device_cap"), false, s);
    }
    assert.equal(deviceCap(null, "capacity_device_cap"), false);
  });

  it("owner alert: dropped_this_device from native only", () => {
    const v = (alert: unknown): AnyView => ({
      native: { owner_alert: alert },
    });
    assert.equal(
      ownerAlert(
        v({ kind: "dropped_this_device", device_id: "D1", seated: [] }),
      ),
      true,
    );
    assert.equal(ownerAlert(v(undefined)), false);
    assert.equal(ownerAlert(v(null)), false);
    assert.equal(ownerAlert(v({ kind: "changed_by_other" })), false);
    assert.equal(ownerAlert(v("dropped_this_device")), false);
    assert.equal(ownerAlert({ native: null }), false);
    assert.equal(ownerAlert(null), false);
    // the one-shot view notice is NOT the alert
    assert.equal(
      ownerAlert({
        native: {},
        ownerNotice: { kind: "dropped_this_device" },
      }),
      false,
    );
  });

  it("names: never an id, never blank, all or nothing", () => {
    assert.equal(displayName(" Laptop ", "D1"), "Laptop");
    assert.equal(displayName("D1", "D1"), null);
    assert.equal(displayName(" D1 ", "D1"), null);
    assert.equal(displayName("", "D1"), null);
    assert.equal(displayName("   ", "D1"), null);
    assert.equal(displayName(null, "D1"), null);
    assert.equal(displayName(5, "D1"), null);
    assert.deepEqual(seatedNames(["U2", "U3"], userName), ["Ana", "Bo"]);
    // one unknown user: the generic copy, never a partial list or the id
    assert.equal(seatedNames(["U2", "U9"], userName), null);
    assert.equal(seatedNames(["U2", "U4"], userName), null);
    assert.equal(seatedNames([], userName), null);
    assert.equal(seatedNames(undefined, userName), null);
    assert.equal(seatedNames(["U2", 7], userName), null);
  });

  it("owner notice display: session name and display names only", () => {
    assert.deepEqual(noticeDisplay(notice("changed_by_other"), ctx()), {
      kind: "changed_by_other",
      device: "Laptop",
    });
    // unknown device, or a session "name" that is the id: "another device"
    assert.deepEqual(
      noticeDisplay(notice("changed_by_other", { device_id: "D-X" }), ctx()),
      { kind: "changed_by_other", device: null },
    );
    assert.deepEqual(
      noticeDisplay(
        notice("changed_by_other", { device_id: "D-SELFNAMED" }),
        ctx(),
      ),
      { kind: "changed_by_other", device: null },
    );
    assert.deepEqual(
      noticeDisplay(notice("seated_by_other", { seated: ["U2", "U3"] }), ctx()),
      { kind: "seated_by_other", device: "Laptop", names: ["Ana", "Bo"] },
    );
    assert.deepEqual(
      noticeDisplay(notice("seated_by_other", { seated: ["U2", "U9"] }), ctx()),
      { kind: "seated_by_other", device: "Laptop", names: null },
    );
    assert.deepEqual(noticeDisplay(notice("dropped_this_device"), ctx()), {
      kind: "dropped_this_device",
      channel: "general",
    });
    // the persistent alert already says it
    assert.equal(
      noticeDisplay(notice("dropped_this_device"), ctx({ alertShown: true })),
      null,
    );
    assert.equal(noticeDisplay(null, ctx()), null);
    assert.equal(noticeDisplay(notice("from_the_future"), ctx()), null);
    // no display value is ever an id
    const shown = JSON.stringify([
      noticeDisplay(notice("seated_by_other", { seated: ["U2", "U3"] }), ctx()),
      noticeDisplay(notice("changed_by_other"), ctx()),
    ]);
    for (const id of ["D-LAPTOP", "U2", "U3"]) {
      assert.ok(!shown.includes(`"${id}"`), `${id} shown`);
    }
  });

  it("signer lost: the 9.2 copy kind from the cause", () => {
    assert.equal(signerLost(lostView(lost())), "owner_device_lost");
    assert.equal(
      signerLost(lostView(lost({ cause: "account_unavailable" }))),
      "owner_account_unavailable",
    );
    assert.equal(signerLost(lostView(lost({ cause: "other" }))), null);
    assert.equal(signerLost(lostView(null)), null);
    assert.equal(signerLost(lostView("device_revoked")), null);
    assert.equal(signerLost(null), null);
  });

  it("recover: only the owner user, only on ANOTHER device", () => {
    const self = { userId: "U1", deviceId: "D-OTHER" };
    assert.equal(recover(lostView(lost()), self), true);
    // another user (not the owner): never
    assert.equal(recover(lostView(lost()), { ...self, userId: "U9" }), false);
    // the lost device itself: never
    assert.equal(
      recover(lostView(lost()), { ...self, deviceId: "D-LOST" }),
      false,
    );
    // the owner's account is unavailable: nothing to recover here
    assert.equal(
      recover(lostView(lost({ cause: "account_unavailable" })), self),
      false,
    );
    assert.equal(recover(lostView(null), self), false);
    assert.equal(recover(lostView(lost()), { userId: "U1" }), false);
    assert.equal(recover(lostView(lost()), {}), false);
    assert.equal(recover(lostView(lost({ user_id: 1 })), self), false);
    assert.equal(recover(lostView(lost({ device_id: "" })), self), false);
    assert.equal(recover(null, self), false);
  });

  it("D36: amber wording and one action, only once escalated", () => {
    assert.deepEqual(
      escalation("resecuring", esc("pending_removal", true, "retry_removal")),
      { note: "slow", action: "retry_removal" },
    );
    assert.deepEqual(
      escalation("resecuring", esc("stale_group", true, "rejoin")),
      { note: "slow", action: "rejoin" },
    );
    assert.deepEqual(
      escalation("resecuring", esc("poisoned_owner", true, "recreate")),
      { note: "slow", action: "recreate" },
    );
    assert.deepEqual(
      escalation("resecuring", esc("poisoned_member", true, null)),
      { note: "waiting_owner", action: null },
    );
    const none = { note: null, action: null };
    // the recover button and the signer-lost line cover these from the start
    assert.deepEqual(
      escalation(
        "resecuring",
        esc("owner_device_lost", true, "recover_ownership"),
      ),
      none,
    );
    for (const c of [
      "owner_account_unavailable",
      "waiting_for_member",
      "other",
    ]) {
      assert.deepEqual(escalation("resecuring", esc(c, true, null)), none, c);
    }
    // not yet escalated: nothing
    assert.deepEqual(
      escalation("resecuring", esc("pending_removal", false, null)),
      none,
    );
    assert.deepEqual(
      escalation("resecuring", esc("poisoned_owner", false, "recreate")),
      none,
    );
    // never outside resecuring (escalation never turns a state)
    for (const s of SHIELD_STATES.filter((x) => x !== "resecuring")) {
      assert.deepEqual(
        escalation(s, esc("pending_removal", true, "retry_removal")),
        none,
        s,
      );
    }
    assert.deepEqual(escalation("resecuring", null), none);
    // an action the cause does not carry is never invented
    assert.deepEqual(
      escalation("resecuring", esc("stale_group", true, "recreate")),
      { note: "slow", action: null },
    );
  });

  it("D36 recreate: the escalation offers it only to the list signer", () => {
    const v = {
      recreateAvailable: false,
      ownerChangePending: false,
      native: {
        seat_list: { signer_user_id: "U1", signer_device_id: "D1" },
        owner_pin: null,
      },
    };
    const self = { userId: "U1", deviceId: "D1" };
    assert.equal(recreate3(v, self, false), false);
    assert.equal(recreate3(v, self, true), true);
    assert.equal(recreate3(v, { userId: "U1", deviceId: "D9" }, true), false);
    assert.equal(recreate3(null, self, true), false);
  });
});

// ---- P8: S2 wiring (W4-3 lane U2) --------------------------------------------

/** The JSX element opened at `start` up to its closing tag. */
function elementAt(src: string, start: number, tag: string): string {
  const end = src.indexOf(`</${tag}>`, start);
  assert.ok(end > start, `</${tag}> not found`);
  return src.slice(start, end + tag.length + 3);
}

describe("P8 S2 wiring (U2)", () => {
  it("the owner alert banner: from the view only, never dismissible", () => {
    assert.match(
      PILL_CODE,
      /const ownerAlert = \(\) => pillOwnerAlert\(view\(\)\);/,
    );
    // one use, the definition excluded
    assert.equal(count(PILL_CODE, /(?<!function )\bpillOwnerAlert\(/g), 1);
    const at = PILL_CODE.indexOf("<PanelAlert");
    assert.ok(at >= 0, "alert banner missing");
    assert.equal(count(PILL_CODE, /<PanelAlert\b/g), 1);
    assert.equal(enclosingShow(PILL_CODE, at), "<Show when={ownerAlert()}>");
    const banner = elementAt(PILL_CODE, at, "PanelAlert");
    assert.match(
      banner,
      /ownerNoticeCopy\(\{\s*kind: "dropped_this_device",\s*channel: channelName\(\),\s*\}\)/,
    );
    assert.doesNotMatch(banner, /onClick|<button|PanelAction|close/i);
    assert.match(banner, /role="alert"/);
    // nothing in the pill can hide it
    assert.doesNotMatch(PILL_CODE, /dismiss/i);
    assert.doesNotMatch(PILL_CODE, /set[A-Za-z]*Alert\b/);
  });

  it("notice copy gets the channel NAME (4th arg), never the id", () => {
    assert.match(
      PILL_CODE,
      /noticeCopy\(kind\(\), null, null, channelName\(\)\)/,
    );
    assert.match(
      PILL_CODE,
      /const channelName = \(\) => props\.channel\.name \?\? null;/,
    );
  });

  it("the owner notice: P7 display values, own listing for the device", () => {
    assert.match(
      PILL_CODE,
      /const display = pillOwnerNoticeDisplay\(view\(\)\?\.ownerNotice, \{/,
    );
    assert.match(
      PILL_CODE,
      /return display === null \? null : ownerNoticeCopy\(display\);/,
    );
    assert.equal(count(PILL_CODE, /\bownerNoticeCopy\(/g), 2);
    assert.equal(count(PILL_CODE, /\blistOwnDevices\(\)/g), 1);
    assert.match(PILL_CODE, /e2ee\.listOwnDevices\(\)/);
    // keyed by a memo of the notice's device, so a view emit never refetches
    assert.match(PILL_CODE, /const noticeDeviceId = createMemo\(/);
    assert.match(PILL_CODE, /on\(noticeDeviceId, \(deviceId\) =>/);
    // ids are never rendered as JSX text
    assert.doesNotMatch(
      PILL_CODE,
      /\{[^{}]*\.(device_id|user_id|seated)\b[^{}]*\}\s*</,
    );
  });

  it("Recover ownership: under its Show, from a click only", () => {
    const at = PILL_CODE.indexOf("panelCopy.recoverOwnership()");
    assert.ok(at >= 0, "recover button missing");
    assert.equal(count(PILL_CODE, /panelCopy\.recoverOwnership\(\)/g), 1);
    assert.equal(
      enclosingShow(PILL_CODE, at),
      "<Show when={recoverOffered()}>",
    );
    assert.match(
      PILL_CODE,
      /const recoverOffered = \(\) =>\s*full\(\) && pillRecoverOffered\(view\(\), selfIds\(\)\);/,
    );
    assert.match(
      PILL_CODE,
      /case "recover":\s*action = api\?\.recoverOwnership;/,
    );
  });

  it("D36: guarded read, re-timed, amber wording + one action only", () => {
    assert.equal(count(PILL_CODE, /\bresecureCause\(/g), 1);
    assert.match(
      PILL_CODE,
      /if \(stateNow\(\) !== "resecuring"\) return null;/,
    );
    assert.match(
      PILL_CODE,
      /try \{\s*inputs = api\.resecureInputs\(props\.channel\.id\);\s*\} catch \{\s*return null;\s*\}/,
    );
    assert.match(
      PILL_CODE,
      /return resecureCause\(inputs, Math\.max\(tick\(\), Date\.now\(\)\)\);/,
    );
    assert.match(
      PILL_CODE,
      /const escalation = \(\) => pillEscalation\(stateNow\(\), resecure\(\)\);/,
    );
    // a timer re-evaluates at the escalation time and is cleaned up
    assert.match(
      PILL_CODE,
      /setTimeout\(\(\) => setTick\(Date\.now\(\)\), wait \+ 1\)/,
    );
    assert.match(PILL_CODE, /onCleanup\(\(\) => clearTimeout\(timer\)\)/);
    // the wording sits in the amber element only
    const at = PILL_CODE.indexOf("<PanelEscalation>");
    assert.ok(at >= 0, "escalation element missing");
    assert.equal(
      enclosingShow(PILL_CODE, at),
      "<Show when={escalationText()}>",
    );
    assert.match(PILL_CODE, /var\(--sloga-protected-resecuring\)/);
    // recreate is the D21 button (signer re-checked); the retry actions
    // are ONE manual refresh (U8b: `retryNow`, never the open's loop),
    // only where the open lifecycle runs
    assert.match(
      PILL_CODE,
      /pillRecreateOffered\(view\(\), selfIds\(\), escalation\(\)\.action === "recreate"\)/,
    );
    assert.match(PILL_CODE, /onClick=\{\(\) => retry\(\)\}/);
    assert.equal(count(PILL_CODE, /\bretryNow\(/g), 1);
    assert.match(PILL_CODE, /\n {6}api\.retryNow\(channelId\);\n/);
    assert.equal(count(PILL_CODE, /\bprotectedOpen\b/g), 0);
    assert.match(PILL_CODE, /&& retryAllowed\(\)/);
  });

  it("D38: the device-cap screen opens from a click, open channel only", () => {
    const at = PILL_CODE.indexOf("onClick={() => openDeviceCap()}");
    assert.ok(at >= 0, "device-cap button missing");
    assert.equal(
      enclosingShow(PILL_CODE, at),
      "<Show when={deviceCapOffered()}>",
    );
    assert.match(
      PILL_CODE,
      /const deviceCapOffered = \(\) =>\s*full\(\) &&\s*retryAllowed\(\) &&\s*pillDeviceCapOffered\(stateNow\(\), shield\(\)\?\.notice\);/,
    );
    assert.match(
      PILL_CODE,
      /openModal\(\{\s*type: "protected_device_cap",\s*channel: props\.channel,\s*\} as unknown as ModalRequest\);/,
    );
    // one cast per L9-pending modal (device cap, owner review) and one
    // opener each
    assert.equal(count(PILL_CODE, /\bas unknown as\b/g), 2);
    assert.equal(count(PILL_CODE, /\bopenModal\(/g), 2);
    assert.equal(count(PILL_CODE, /(?<!function )\bopenDeviceCap\(\)/g), 1);
  });

  it("details: capable AND a state with details (outdated: notice only)", () => {
    assert.match(
      PILL_CODE,
      /const details = \(\) => full\(\) && pillShowsDetails\(stateNow\(\)\);/,
    );
    assert.match(PILL_CODE, /<Show when=\{details\(\)\}>/);
    assert.doesNotMatch(PILL_CODE, /<Show when=\{full\(\)\}>/);
  });
});
