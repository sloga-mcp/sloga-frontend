// Spec for the server settings "Protected channels" page (S2-D42 [a], W4-3
// lane U11), run with Node's built-in runner from packages/client:
//   node --conditions=browser --test \
//     components/app/interface/settings/server/protectedChannels.scan.test.ts
//
// ProtectedChannels.tsx and ServerSettings.tsx import Solid, lingui and the
// UI kit, so Node cannot load them. The page's rules sit in one marked
// region (`// protected-pure:begin` .. `// protected-pure:end`) with no
// imports; this spec cuts it out, strips the types with Node's own stripper
// and runs the real source. The pill's pure block is loaded the same way so
// the mirrored recover rule is checked against the pill's own. The wiring
// is checked by scanning both files with comments removed.
//
//  S1  owner only: the page and the entry need `server.ownerId === self`
//      (both known); the entry also needs a protected channel;
//  S2  wiring: the page renders nothing unless `owner()`, the entry's
//      `hidden` goes through the S1 rule, the page id is registered once;
//  S3  seat usage: seats used of the slot cap; a null cap stays unknown
//      (never 0); no read = "not loaded"; agrees with the pill's pillSeats;
//  S4  "Recover ownership on this device": owner user, ANOTHER device,
//      `device_revoked`, capable only; agrees with the pill's
//      pillRecoverOffered on every case;
//  S5  the native dialog runs only from the recover button's click, which
//      exists only while S4 offers it, and the click re-checks; the one
//      automatic step is the own device listing READ (U11b);
//  S6  no signing of its own (revised by U11b for S2-D42): the page reaches
//      the bridge only through `recoverOwnership` / `moveOwnerKey` /
//      `seatsSnapshot` / `selfDeviceId` / the view map and the own listing
//      read; never the native handover command, `textApi` or a raw request;
//  S7  no id is ever rendered; the channel NAME is the only channel field;
//  S8  copy through t / protectedCopy only; exhaustive seat-line switch;
//  S9  blank-page traps: string-tag styled only, no use:floating, no barrel;
//  S10 failures map through protectedNoticeForError(op owner) and
//      errorUiCopy(answer, { failure: err }), never an error's message;
//  S11 (U11b) "Move ownership key to another device" is offered on the
//      signing device only, with F5's ownerKeyMoveTargets (run for real)
//      naming the targets; another own device or a served authority gets
//      its explanatory line; nothing while recover is offered;
//  S12 (U11b) `ui.moveOwnerKey` runs only from a picker row's click, which
//      re-checks that the device is still offered; rows show session names
//      ("Unnamed device" fallback), never ids.
//
// `PROTECTED_CHANNELS_PAGE_FILE` / `PROTECTED_SERVER_SETTINGS_FILE` point at
// other copies (a known-bad control); they must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(here, "../../../../..");
const source = readFileSync(
  process.env.PROTECTED_CHANNELS_PAGE_FILE ||
    join(here, "ProtectedChannels.tsx"),
  "utf8",
);
const settingsSource = readFileSync(
  process.env.PROTECTED_SERVER_SETTINGS_FILE ||
    resolve(here, "../ServerSettings.tsx"),
  "utf8",
);
const PILL_PATH = resolve(
  CLIENT_ROOT,
  "src/interface/channels/ProtectedChannelPill.tsx",
);
const SHIELD_PATH = resolve(
  CLIENT_ROOT,
  "components/client/protectedShield.ts",
);

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

type SeatLine =
  | { kind: "of"; used: number; cap: number }
  | { kind: "unknown_cap"; used: number }
  | { kind: "not_loaded" };
type Self = { userId?: string | null; deviceId?: string | null };
interface Rules {
  protectedChannelsOwner(ownerId: unknown, selfId: unknown): boolean;
  protectedChannelsEntryShown(i: {
    ownerId: unknown;
    selfId: unknown;
    protectedCount: number;
  }): boolean;
  protectedChannelSeatLine(snapshot: unknown): SeatLine;
  protectedChannelsRecoverOffered(
    view: unknown,
    self: Self,
    capable: boolean,
  ): boolean;
  protectedChannelsSignedByUser(snapshot: unknown, userId: unknown): boolean;
  protectedChannelsOwnerKey(i: OwnerKeyInput): OwnerKey;
}
type OwnDevice = { deviceId: string; sessionName: string | null };
type OwnerKeyInput = {
  snapshot: unknown;
  selfUserId: string | null | undefined;
  selfDeviceId: string | null | undefined;
  ownDevices: OwnDevice[] | null;
  targets: string[];
  capable: boolean;
  recoverOffered: boolean;
};
type OwnerKey =
  | { kind: "move"; targets: { deviceId: string; name: string | null }[] }
  | { kind: "on_other_device" }
  | { kind: "authority_held" }
  | { kind: "none" };
const RULE_NAMES = [
  "protectedChannelsOwner",
  "protectedChannelsEntryShown",
  "protectedChannelSeatLine",
  "protectedChannelsRecoverOffered",
  "protectedChannelsSignedByUser",
  "protectedChannelsOwnerKey",
] as const;
const OWNER_FLOWS_PATH = resolve(
  CLIENT_ROOT,
  "components/client/protectedTextOwner.ts",
);

async function importJs(js: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "s2w43-U11-"));
  const out = join(dir, name);
  writeFileSync(out, js);
  return (await import(pathToFileURL(out).href)) as Record<string, unknown>;
}

let rulesPromise: Promise<Rules> | null = null;
function loadRules(): Promise<Rules> {
  rulesPromise ??= (async () => {
    const from = source.indexOf(BEGIN);
    const to = source.indexOf(END);
    assert.ok(from !== -1 && to > from, "protected-pure region missing");
    const region = source.slice(from, to);
    assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
    const mod = await importJs(
      stripTypeScriptTypes(region, { mode: "strip" }),
      "protectedChannelsPure.mjs",
    );
    for (const name of RULE_NAMES) {
      assert.equal(typeof mod[name], "function", `${name} missing`);
    }
    return mod as unknown as Rules;
  })();
  return rulesPromise;
}

/** The pill's pure block, loaded as protectedPill.scan.test.ts loads it. */
let pillPromise: Promise<Record<string, unknown>> | null = null;
function loadPill(): Promise<Record<string, unknown>> {
  pillPromise ??= (async () => {
    const pill = readFileSync(PILL_PATH, "utf8");
    const begin = pill.indexOf("// --- pure: begin");
    const end = pill.indexOf("// --- pure: end");
    assert.ok(begin >= 0 && end > begin, "pill pure block markers missing");
    const js =
      `import { shieldPresentation } from ${JSON.stringify(
        pathToFileURL(SHIELD_PATH).href,
      )};\n` + stripTypeScriptTypes(pill.slice(begin, end), { mode: "strip" });
    return importJs(js, "pillPure.mjs");
  })();
  return pillPromise;
}

/** Drop block, JSX-block and whole-line comments so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(source);
const SETTINGS = code(settingsSource);
const count = (s: string, needle: string) => s.split(needle).length - 1;

/** The component body: from its declaration to the pure region. */
function componentBody(): string {
  const from = source.indexOf("export function ProtectedChannels(");
  assert.ok(from !== -1, "ProtectedChannels missing");
  const to = source.indexOf(BEGIN, from);
  assert.ok(to > from, "the component must precede the pure region");
  return code(source.slice(from, to));
}

const BODY = componentBody();

/** A slice of the component body from `head` to the first `end` after it. */
function block(head: string, end: string): string {
  const from = BODY.indexOf(head);
  assert.ok(from !== -1, `${head} missing`);
  const to = BODY.indexOf(end, from + head.length);
  assert.ok(to > from, `${head} has no end`);
  return BODY.slice(from, to + end.length);
}

const renderBlock = () => block("  return (\n    <Show", "\n  );\n");
const recoverFn = () =>
  block("async function recover(channelId: string) {", "\n  }\n");
const seatLineFn = () => block("const seatLine = (", "\n  };\n");
const moveFn = () =>
  block(
    "async function move(channelId: string, deviceId: string) {",
    "\n  }\n",
  );
const listingEffect = () => block("  createEffect(", "\n  );\n");

/** F5's real `ownerKeyMoveTargets`, as the page calls it. */
let flowsPromise: Promise<{
  ownerKeyMoveTargets(
    seats: unknown,
    selfDeviceId: string | null,
    ownDevices: readonly string[],
  ): string[];
}> | null = null;
function loadFlows() {
  flowsPromise ??= (async () => {
    const mod = (await import(pathToFileURL(OWNER_FLOWS_PATH).href)) as Record<
      string,
      unknown
    >;
    assert.equal(typeof mod.ownerKeyMoveTargets, "function");
    return mod as never;
  })();
  return flowsPromise;
}

// ---- fixtures -----------------------------------------------------------

const lostView = (lost: unknown) => ({ serverGroup: { signer_lost: lost } });
const LOST = { user_id: "U1", device_id: "D_LOST", cause: "device_revoked" };
const OTHER: Self = { userId: "U1", deviceId: "D_OTHER" };

/** Every recover case the spec checks (view, self). */
const RECOVER_CASES: Array<[string, unknown, Self, boolean]> = [
  ["owner user on another device", lostView(LOST), OTHER, true],
  [
    "the lost device itself",
    lostView(LOST),
    { userId: "U1", deviceId: "D_LOST" },
    false,
  ],
  [
    "another user",
    lostView(LOST),
    { userId: "U2", deviceId: "D_OTHER" },
    false,
  ],
  [
    "cause account_unavailable",
    lostView({ ...LOST, cause: "account_unavailable" }),
    OTHER,
    false,
  ],
  ["unknown cause", lostView({ ...LOST, cause: "other" }), OTHER, false],
  ["no cause", lostView({ user_id: "U1", device_id: "D_LOST" }), OTHER, false],
  ["no signer_lost", lostView(null), OTHER, false],
  ["no serverGroup", {}, OTHER, false],
  ["no view", null, OTHER, false],
  ["signer_lost not an object", lostView("U1"), OTHER, false],
  [
    "self user unknown",
    lostView(LOST),
    { userId: null, deviceId: "D_OTHER" },
    false,
  ],
  [
    "self user blank",
    lostView(LOST),
    { userId: "", deviceId: "D_OTHER" },
    false,
  ],
  [
    "self device unknown",
    lostView(LOST),
    { userId: "U1", deviceId: undefined },
    false,
  ],
  ["self device blank", lostView(LOST), { userId: "U1", deviceId: "" }, false],
  ["lost device blank", lostView({ ...LOST, device_id: "" }), OTHER, false],
  [
    "lost device not a string",
    lostView({ ...LOST, device_id: 7 }),
    OTHER,
    false,
  ],
  ["lost user not a string", lostView({ ...LOST, user_id: 1 }), OTHER, false],
];

// ---- S1 / S2 owner only -------------------------------------------------

test("S1 the page and the entry are the server owner's only", async () => {
  const r = await loadRules();
  assert.equal(r.protectedChannelsOwner("U1", "U1"), true);
  for (const [o, s] of [
    ["U1", "U2"],
    ["U1", undefined],
    ["U1", null],
    ["U1", ""],
    [undefined, "U1"],
    [null, "U1"],
    ["", ""],
    [undefined, undefined],
    [null, null],
  ] as Array<[unknown, unknown]>) {
    assert.equal(r.protectedChannelsOwner(o, s), false, `${o} / ${s}`);
  }
  assert.equal(
    r.protectedChannelsEntryShown({
      ownerId: "U1",
      selfId: "U1",
      protectedCount: 1,
    }),
    true,
  );
  assert.equal(
    r.protectedChannelsEntryShown({
      ownerId: "U1",
      selfId: "U1",
      protectedCount: 0,
    }),
    false,
    "no protected channel, no entry",
  );
  assert.equal(
    r.protectedChannelsEntryShown({
      ownerId: "U1",
      selfId: "U2",
      protectedCount: 3,
    }),
    false,
    "a non-owner never sees the entry",
  );
  assert.equal(
    r.protectedChannelsEntryShown({
      ownerId: "U1",
      selfId: undefined,
      protectedCount: 3,
    }),
    false,
  );
});

test("S2 the page renders only for the owner and the entry goes through the owner rule", () => {
  // The page: its one return is a Show over owner(), and owner() is S1's rule.
  assert.equal(count(BODY, "\n  return ("), 1, "one return in the page");
  assert.match(renderBlock(), /^ {2}return \(\n {4}<Show when=\{owner\(\)\}>/);
  assert.match(
    BODY,
    /const owner = \(\) =>\s*protectedChannelsOwner\(props\.server\.ownerId, client\(\)\?\.user\?\.id\);/,
  );
  // The registry: the entry's `hidden` is the negated S1 entry rule over
  // the server owner and this user.
  const at = SETTINGS.indexOf('id: "protected_channels"');
  assert.ok(at !== -1, "entry missing");
  assert.equal(count(SETTINGS, 'id: "protected_channels"'), 1);
  // The group holding the entry: from its own `hidden:` to the entry id,
  // with no other `hidden:` (an entry-level one) in between.
  const hiddenAt = SETTINGS.lastIndexOf("hidden:", at);
  assert.ok(hiddenAt !== -1 && at - hiddenAt < 600, "group hidden missing");
  const group = SETTINGS.slice(hiddenAt, at);
  assert.match(
    group,
    /^hidden: !protectedChannelsEntryShown\(\{\s*ownerId: server\.ownerId,\s*selfId: user\(\)\?\.id,\s*protectedCount: server\.channels\.filter\(\(channel\) =>\s*client\(\)\.isProtectedChannel\(channel\.id\),\s*\)\.length,\s*\}\),\s*title: <Trans>Protected channels<\/Trans>,\s*entries: \[\s*\{\s*$/,
  );
  assert.equal(count(SETTINGS, 'case "protected_channels":'), 1);
  assert.match(
    SETTINGS,
    /case "protected_channels":\s*return <ProtectedChannels server=\{server\} \/>;/,
  );
  assert.match(
    SETTINGS,
    /import \{\s*ProtectedChannels,\s*protectedChannelsEntryShown,\s*\} from "\.\/server\/ProtectedChannels";/,
  );
});

// ---- S3 seat usage ------------------------------------------------------

test("S3 seat usage: used of the slot cap, a null cap stays unknown, no read is not loaded", async () => {
  const r = await loadRules();
  const pill = await loadPill();
  const pillSeats = pill.pillSeats as (s: unknown) => {
    used: number;
    cap: number | null;
  } | null;
  assert.equal(typeof pillSeats, "function", "pill pillSeats missing");
  const cases: Array<[unknown, SeatLine]> = [
    [
      { seats_used: 3, slot_cap: 10 },
      { kind: "of", used: 3, cap: 10 },
    ],
    [
      { seats_used: 0, slot_cap: 1 },
      { kind: "of", used: 0, cap: 1 },
    ],
    [
      { seats_used: 3, slot_cap: null },
      { kind: "unknown_cap", used: 3 },
    ],
    [
      { seats_used: 3, slot_cap: 0 },
      { kind: "unknown_cap", used: 3 },
    ],
    [
      { seats_used: 3, slot_cap: 2.5 },
      { kind: "unknown_cap", used: 3 },
    ],
    [{ seats_used: 3 }, { kind: "unknown_cap", used: 3 }],
    [{ seats_used: -1, slot_cap: 5 }, { kind: "not_loaded" }],
    [{ seats_used: "3", slot_cap: 5 }, { kind: "not_loaded" }],
    [{ slot_cap: 5 }, { kind: "not_loaded" }],
    [null, { kind: "not_loaded" }],
    [undefined, { kind: "not_loaded" }],
  ];
  for (const [snap, want] of cases) {
    const got = r.protectedChannelSeatLine(snap);
    assert.deepEqual(got, want, JSON.stringify(snap));
    // Same decision as the pill's seat line.
    const p = pillSeats(snap);
    const mapped: SeatLine =
      p === null
        ? { kind: "not_loaded" }
        : p.cap === null
          ? { kind: "unknown_cap", used: p.used }
          : { kind: "of", used: p.used, cap: p.cap };
    assert.deepEqual(got, mapped, `pill disagrees: ${JSON.stringify(snap)}`);
  }
  // The rendered line: the known cap through settingsCopy, the unknown cap
  // through the existing "isn't known yet" copy, never a 0 or a guess.
  const fn = seatLineFn();
  assert.match(
    fn,
    /case "of":\s*return settingsCopy\.seatsUsed\(line\.used, line\.cap\);/,
  );
  assert.match(
    fn,
    /case "unknown_cap": \{\s*const count = line\.used;\s*return t`Seats used: \$\{count\}\. The seat limit isn't known yet\.`;/,
  );
  assert.equal(count(fn, "settingsCopy.seatsUsed("), 1);
});

// ---- S4 / S5 recover ----------------------------------------------------

test("S4 recover is offered only to the owner user on another device, capable, device_revoked", async () => {
  const r = await loadRules();
  const pill = await loadPill();
  const pillRecover = pill.pillRecoverOffered as (
    v: unknown,
    s: Self,
  ) => boolean;
  assert.equal(
    typeof pillRecover,
    "function",
    "pill pillRecoverOffered missing",
  );
  for (const [name, view, self, want] of RECOVER_CASES) {
    assert.equal(
      r.protectedChannelsRecoverOffered(view, self, true),
      want,
      name,
    );
    assert.equal(pillRecover(view, self), want, `pill: ${name}`);
    assert.equal(
      r.protectedChannelsRecoverOffered(view, self, false),
      false,
      `not capable: ${name}`,
    );
  }
  // Wired with this session's ids and the capability.
  assert.match(
    BODY,
    /const recoverOffered = \(channelId: string\) =>\s*protectedChannelsRecoverOffered\(view\(channelId\), self\(\), capable\(\)\);/,
  );
  assert.match(
    BODY,
    /const capable = \(\) => ui\(\)\?\.protectedTextCapable\(\) === true;/,
  );
});

test("S5 the native dialog runs only from the recover button, shown only while offered", () => {
  // recoverOwnership: exactly once, inside recover(), after the re-check.
  // (`panelCopy.recoverOwnership()` is the button's copy, not the call.)
  assert.equal(
    count(
      CODE.replace("panelCopy.recoverOwnership()", ""),
      "recoverOwnership(",
    ),
    1,
    "one recoverOwnership call",
  );
  const fn = recoverFn();
  assert.ok(fn.includes("await api.recoverOwnership(channelId);"));
  const guard = fn.indexOf(
    "if (busy() !== null || !owner() || !recoverOffered(channelId)) return;",
  );
  assert.ok(guard !== -1, "the click re-checks owner and the offer");
  assert.ok(
    guard < fn.indexOf("recoverOwnership("),
    "re-check before the call",
  );
  // recover( is called from the button's press only.
  assert.equal(count(BODY, "recover(channel.id)"), 1);
  assert.equal(
    count(BODY.replace("async function recover(", ""), "recover("),
    1,
  );
  const render = renderBlock();
  assert.match(
    render,
    /<Show when=\{recoverOffered\(channel\.id\)\}>\s*<Line>\{noticeCopy\("owner_device_lost"\)\}<\/Line>\s*<div>\s*<Button\s+variant="filled"\s+isDisabled=\{busy\(\) !== null\}\s+onPress=\{\(\) => void recover\(channel\.id\)\}\s*>\s*\{panelCopy\.recoverOwnership\(\)\}\s*<\/Button>\s*<\/div>\s*<\/Show>/,
  );
  // Nothing runs on its own but the own device listing READ (U11b: the
  // move offer needs it before any click). It is the one effect, keyed on
  // the "a list names this user as signer" memo, and it calls nothing but
  // `listOwnDevices` and the setter.
  for (const auto of [
    "onMount",
    "createResource",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
  ]) {
    assert.ok(!CODE.includes(auto), `${auto} in the page`);
  }
  assert.equal(count(CODE, "createEffect("), 1, "one effect");
  const effect = listingEffect();
  assert.match(
    effect,
    /^ {2}createEffect\(\n {4}on\(ownListingWanted, \(wanted\) => \{\n {6}if \(!wanted\) return;\n/,
  );
  const calls = [...effect.matchAll(/([A-Za-z_$][\w$]*)\(/g)]
    .map((m) => m[1])
    .filter((n) => !["createEffect", "on", "if", "bridge"].includes(n));
  assert.deepEqual(
    [...new Set(calls)].sort(),
    ["listOwnDevices", "onCleanup", "setOwnDevices", "then", "warn"],
    "the effect only reads the listing",
  );
  assert.match(
    BODY,
    /const ownListingWanted = createMemo\(\s*\(\) =>\s*capable\(\) &&\s*channels\(\)\.some\(\(ch\) =>\s*protectedChannelsSignedByUser\(snapshot\(ch\.id\), self\(\)\.userId\),\s*\),\s*\);/,
  );
});

// ---- S6 no signing of its own (revised by U11b) ---------------------------

// U11 had "no handover at all" (no webview flow existed). The S2-D42 ruling
// puts "Move ownership key" here through F5's `ui.moveOwnerKey`; what stays
// banned is the page signing or publishing anything itself.
test("S6 no signing of its own: the bridge only through recoverOwnership, moveOwnerKey, seatsSnapshot, selfDeviceId, the views and the own listing", () => {
  for (const banned of [
    "andover",
    "authoritySign",
    "setSeats",
    "protect(",
    "textApi",
    "invoke",
    "e2ee_text_",
    "_sign",
    "Sign(",
    ".api.",
    "fetch(",
    "protectedOpen",
    "retryNow",
    "openModal",
  ]) {
    assert.ok(!CODE.includes(banned), `the page must not use ${banned}`);
  }
  // Every bridge member the page touches, by name.
  const members = new Set(
    [...BODY.matchAll(/\b(?:api|ui\(\)\?)\.(\w+)/g)].map((m) => m[1]),
  );
  assert.deepEqual([...members].sort(), [
    "moveOwnerKey",
    "protectedChannels",
    "protectedTextCapable",
    "recoverOwnership",
    "seatsSnapshot",
    "selfDeviceId",
  ]);
  // The bridge itself: its status and the own listing read only.
  const bridgeMembers = new Set(
    [...BODY.matchAll(/\b(?:e2ee|bridge\(\)\??)\.(\w+)/g)].map((m) => m[1]),
  );
  assert.deepEqual([...bridgeMembers].sort(), ["listOwnDevices", "status"]);
  // From F5's module only the pure target rule, never a flow.
  assert.equal(count(CODE, "protectedTextOwner"), 1);
  assert.ok(
    CODE.includes(
      'import { ownerKeyMoveTargets } from "@revolt/client/protectedTextOwner";',
    ),
  );
});

// ---- S7 no ids ----------------------------------------------------------

test("S7 no id is ever rendered; the channel name is the only channel field shown", () => {
  const render = renderBlock();
  // JSX children: `{...}` right after a tag close.
  const children = [
    ...render.matchAll(/>\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g),
  ].map((m) => m[1]);
  assert.ok(children.length >= 4, "JSX children found");
  for (const c of children) {
    // A render callback's event handlers (U11b: the picker row's `onPress`)
    // take ids as arguments, never as text; everything else is checked.
    const shown = c
      .replace(/\bon[A-Z]\w*=\{[^{}]*\}/g, "")
      .replace(/channel\.id\)/g, "");
    assert.ok(!/\bid\b|Id\b|\.id\b/.test(shown), `id rendered: ${c}`);
  }
  assert.ok(render.includes("<Name>{channel.name}</Name>"));
  assert.ok(
    !/\{channel\.(?!name\b|id\))\w+/.test(render),
    "only channel.name / channel.id args",
  );
  // The failure text is copy: errorUiCopy's answer or a notice, never an id.
  const sets = [...BODY.matchAll(/setFailure\(\{([^}]*)\}\)/g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(sets, [
    'channelId, text: noticeCopy("not_available")',
    "channelId, text",
    // U11b: the move click, same two shapes.
    'channelId, text: noticeCopy("not_available")',
    "channelId, text",
  ]);
  assert.equal(
    count(BODY, "const text = errorUiCopy(answer, { failure: err });"),
    2,
  );
  // U11b: a picker row shows the session name or "Unnamed device"; the
  // device id is only the click's argument.
  assert.ok(
    render.includes("{target.name ?? ownerKeyCopy.unnamedDevice()}"),
    "picker rows show the session name",
  );
  assert.equal(count(render, "target.deviceId"), 1);
  assert.match(
    render,
    /onPress=\{\(\) =>\s*void move\(channel\.id, target\.deviceId\)\s*\}/,
  );
});

// ---- S8 copy ------------------------------------------------------------

test("S8 copy through t and protectedCopy only; the seat-line switch is exhaustive", () => {
  const render = renderBlock();
  // No bare text between tags.
  assert.ok(!/>[^<>{}\s][^<>{}]*</.test(render), "bare JSX text");
  const fn = seatLineFn();
  assert.match(fn, /default: \{\s*const _exhaustive: never = kind;/);
  for (const kind of ["of", "unknown_cap", "not_loaded"]) {
    assert.ok(fn.includes(`case "${kind}":`), kind);
  }
  assert.match(
    fn,
    /case "not_loaded":\s*return capable\(\) \? t`Open this channel to see its seats\.` : null;/,
  );
  // U11b: the owner-key line is exhaustive over the rule's kinds.
  const keyLine = block("const ownerKeyLine = (", "\n  };\n");
  assert.match(keyLine, /default: \{\s*const _exhaustive: never = kind;/);
  assert.match(
    keyLine,
    /case "move":\s*case "none":\s*return null;\s*case "on_other_device":\s*return ownerKeyCopy\.onOtherDevice\(\);\s*case "authority_held":\s*return ownerKeyCopy\.authorityHeld\(\);/,
  );
  // The registry entry's title is a Trans.
  assert.equal(count(SETTINGS, "<Trans>Protected channels</Trans>"), 2);
});

// ---- S9 blank-page traps -------------------------------------------------

test("S9 blank-page traps: string-tag styled only, no use:floating, no barrel import", () => {
  const styledCalls = [...CODE.matchAll(/styled\(([^,)]*)/g)].map((m) =>
    m[1].trim(),
  );
  assert.ok(styledCalls.length > 0);
  for (const arg of styledCalls)
    assert.match(arg, /^"[a-z]+"$/, `styled(${arg})`);
  assert.ok(!CODE.includes("use:floating"));
  assert.ok(!/from "@revolt\/ui"/.test(CODE), "no @revolt/ui barrel");
  assert.ok(!/features\/legacy"/.test(CODE), "no legacy barrel");
  assert.ok(CODE.includes('from "@revolt/ui/components/design/Button"'));
});

// ---- S10 failures ---------------------------------------------------------

test("S10 failures map through protectedNoticeForError op owner and errorUiCopy, never message", () => {
  const fn = recoverFn();
  assert.match(
    fn,
    /\} catch \(err\) \{\s*const answer = protectedNoticeForError\(err, \{ op: "owner" \}\);\s*const text = errorUiCopy\(answer, \{ failure: err \}\);\s*if \(text\) \{/,
  );
  assert.ok(!CODE.includes(".message"), "never an error's message");
  assert.match(fn, /\} finally \{\s*setBusy\(null\);\s*\}/);
  // U11b: the move click maps the same way (F5's client refusals get
  // their own copy through `failure: err`).
  const mv = moveFn();
  assert.match(
    mv,
    /\} catch \(err\) \{\s*const answer = protectedNoticeForError\(err, \{ op: "owner" \}\);\s*const text = errorUiCopy\(answer, \{ failure: err \}\);\s*if \(text\) \{/,
  );
  assert.match(mv, /\} finally \{\s*setBusy\(null\);\s*\}/);
});

// ---- S11 / S12 move ownership key (U11b, S2-D42) --------------------------

const U = "U1";
const K0 = "DEV_K0";
const K1 = "DEV_K1";
const K2 = "DEV_K2";
const K3 = "DEV_K3";
const OWN: OwnDevice[] = [
  { deviceId: K0, sessionName: "This PC" },
  { deviceId: K1, sessionName: " Laptop " },
  { deviceId: K2, sessionName: null },
  { deviceId: K3, sessionName: "   " },
];
const seats = (list: Record<string, unknown> | null) => ({
  list:
    list === null
      ? null
      : { body: "b", signature: "s", version: 3, handovers: [], ...list },
  seats_used: 1,
  slot_cap: 10,
});
const signedBy = (user: string, device: string, extra = {}) =>
  seats({ signer_user_id: user, signer_device_id: device, ...extra });

test("S11 move ownership key: offered on the signing device only, named by session; otherwise the reason line", async () => {
  const r = await loadRules();
  const { ownerKeyMoveTargets } = await loadFlows();
  /** The page's composition: F5's targets, then the page rule. */
  const key = (over: Partial<OwnerKeyInput> & { snapshot: unknown }) => {
    const i: OwnerKeyInput = {
      selfUserId: U,
      selfDeviceId: K0,
      ownDevices: OWN,
      targets: [],
      capable: true,
      recoverOffered: false,
      ...over,
    };
    i.targets = ownerKeyMoveTargets(
      i.snapshot,
      i.selfDeviceId ?? null,
      (i.ownDevices ?? []).map((d) => d.deviceId),
    );
    return r.protectedChannelsOwnerKey(i);
  };
  const MOVE = {
    kind: "move",
    targets: [
      { deviceId: K1, name: "Laptop" },
      { deviceId: K2, name: null },
      { deviceId: K3, name: null },
    ],
  };
  // K0 signs: every other own device, in listing order, by session name.
  assert.deepEqual(key({ snapshot: signedBy(U, K0) }), MOVE);
  // K0 alone in the listing, or no listing yet: nothing to offer.
  assert.deepEqual(key({ snapshot: signedBy(U, K0), ownDevices: [OWN[0]] }), {
    kind: "none",
  });
  assert.deepEqual(key({ snapshot: signedBy(U, K0), ownDevices: null }), {
    kind: "none",
  });
  // Another own device signs: explain, never offer.
  assert.deepEqual(key({ snapshot: signedBy(U, K1) }), {
    kind: "on_other_device",
  });
  // ... unless that device is not in the listing (signed out: recover's
  // case) or recover is offered.
  assert.deepEqual(key({ snapshot: signedBy(U, "DEV_GONE") }), {
    kind: "none",
  });
  assert.deepEqual(key({ snapshot: signedBy(U, K1), recoverOffered: true }), {
    kind: "none",
  });
  assert.deepEqual(key({ snapshot: signedBy(U, K0), recoverOffered: true }), {
    kind: "none",
  });
  // A served authority: F5 refuses the handover; the line says why, on
  // every own device.
  const authority = { body: "a", signature: "s" };
  for (const device of [K0, K1]) {
    assert.deepEqual(key({ snapshot: signedBy(U, device, { authority }) }), {
      kind: "authority_held",
    });
  }
  // Another user's list, no list, not capable, unknown self: nothing.
  for (const [name, over] of [
    ["another user", { snapshot: signedBy("U2", K0) }],
    ["another user, other device", { snapshot: signedBy("U2", K1) }],
    ["no list", { snapshot: seats(null) }],
    ["no snapshot", { snapshot: null }],
    ["not capable", { snapshot: signedBy(U, K0), capable: false }],
    ["self device unknown", { snapshot: signedBy(U, K1), selfDeviceId: null }],
    ["self user unknown", { snapshot: signedBy(U, K0), selfUserId: null }],
    ["self user blank", { snapshot: signedBy("", K0), selfUserId: "" }],
  ] as Array<[string, Partial<OwnerKeyInput> & { snapshot: unknown }]>) {
    assert.deepEqual(key(over), { kind: "none" }, name);
  }
  // The rule never offers a device F5 did not, nor this device.
  const direct = r.protectedChannelsOwnerKey({
    snapshot: signedBy(U, K0),
    selfUserId: U,
    selfDeviceId: K0,
    ownDevices: OWN,
    targets: [K0, K1, "DEV_NOT_OWN"],
    capable: true,
    recoverOffered: false,
  });
  assert.deepEqual(direct, {
    kind: "move",
    targets: [{ deviceId: K1, name: "Laptop" }],
  });
  // Nor on a device that does not sign the served list, whatever it is
  // handed (only the signer can sign the handover).
  assert.deepEqual(
    r.protectedChannelsOwnerKey({
      snapshot: signedBy(U, K1),
      selfUserId: U,
      selfDeviceId: K0,
      ownDevices: OWN,
      targets: [K2],
      capable: true,
      recoverOffered: false,
    }),
    { kind: "on_other_device" },
  );
  // The listing read: only while a list names this user as signer.
  assert.equal(r.protectedChannelsSignedByUser(signedBy(U, K1), U), true);
  for (const [snap, user] of [
    [signedBy("U2", K0), U],
    [signedBy(U, K0), "U2"],
    [signedBy(U, K0), ""],
    [signedBy(U, K0), null],
    [seats(null), U],
    [null, U],
  ] as Array<[unknown, string | null]>) {
    assert.equal(r.protectedChannelsSignedByUser(snap, user), false);
  }
  // Wired with F5's helper over this session's ids and the listing.
  assert.match(
    BODY,
    /return protectedChannelsOwnerKey\(\{\s*snapshot: snapshot\(channelId\),\s*selfUserId: self\(\)\.userId,\s*selfDeviceId: selfDeviceId\(\),\s*ownDevices: own,\s*targets: ownerKeyMoveTargets\(\s*snapshot\(channelId\),\s*selfDeviceId\(\),\s*\(own \?\? \[\]\)\.map\(\(d\) => d\.deviceId\),\s*\),\s*capable: capable\(\),\s*recoverOffered: recoverOffered\(channelId\),\s*\}\);/,
  );
  assert.match(
    BODY,
    /const selfDeviceId = \(\): string \| null => \{\s*const api = ui\(\);\s*if \(!api \|\| typeof api\.selfDeviceId !== "function"\) return null;\s*try \{\s*return api\.selfDeviceId\(\);\s*\} catch \{\s*return null;\s*\}\s*\};/,
  );
  assert.match(BODY, /return key\.kind === "move" \? key\.targets : null;/);
});

test("S12 moveOwnerKey runs only from a picker row's click, re-checked; rows show names, never ids", () => {
  // One call, inside move(), after the re-checks.
  assert.equal(count(CODE, "moveOwnerKey("), 1, "one moveOwnerKey call");
  const fn = moveFn();
  const call = fn.indexOf("await api.moveOwnerKey(channelId, deviceId);");
  assert.ok(call !== -1);
  for (const guard of [
    "if (busy() !== null || !owner() || picking() !== channelId) return;",
    "const offered = moveTargets(channelId);",
    "if (!offered || !offered.some((d) => d.deviceId === deviceId)) return;",
  ]) {
    const at = fn.indexOf(guard);
    assert.ok(at !== -1 && at < call, `re-check before the call: ${guard}`);
  }
  // move( only from a picker row; the picker only from its button.
  assert.equal(count(BODY.replace("async function move(", ""), "move("), 1);
  assert.equal(
    count(BODY.replace("function openPicker(", ""), "openPicker("),
    1,
  );
  assert.match(
    block("function openPicker(channelId: string) {", "\n  }\n"),
    /if \(busy\(\) !== null \|\| moveTargets\(channelId\) === null\) return;/,
  );
  // The render: the button and the picker exist only while offered.
  const render = renderBlock();
  assert.match(
    render,
    /<Show when=\{moveTargets\(channel\.id\)\}>\s*\{\(targets\) => \(\s*<Show\s+when=\{picking\(\) === channel\.id\}\s+fallback=\{\s*<div>\s*<Button\s+variant="tonal"\s+isDisabled=\{busy\(\) !== null\}\s+onPress=\{\(\) => openPicker\(channel\.id\)\}\s*>\s*\{ownerKeyCopy\.moveKey\(\)\}\s*<\/Button>\s*<\/div>\s*\}\s*>\s*<Line>\{ownerKeyCopy\.choose\(\)\}<\/Line>\s*<Targets role="list">\s*<For each=\{targets\(\)\}>/,
  );
  assert.match(
    render,
    /<Show when=\{ownerKeyLine\(channel\.id\)\}>\s*\{\(line\) => <Line>\{line\(\)\}<\/Line>\}\s*<\/Show>/,
  );
  // A success closes the picker; a failure keeps it with the copy.
  assert.match(
    fn,
    /await api\.moveOwnerKey\(channelId, deviceId\);\s*setPicking\(null\);\s*\} catch/,
  );
});
