// Spec for the Protected channel device-cap modal (S2-D38, W4-3 lane U6),
// run with Node's built-in runner from packages/client:
//   node --conditions=browser --test components/modal/modals/protectedDeviceCap.scan.test.ts
//
// ProtectedDeviceCap.tsx imports Solid, lingui and the UI kit, so Node
// cannot load it. Its rules sit in one marked region
// (`// protected-pure:begin` .. `// protected-pure:end`) with no imports;
// this spec cuts it out, strips the types with Node's own stripper and runs
// the real source. The wiring is checked by scanning the component.
//
//  D1  rows come from the own listing (`session_id`, `session_name`) as the
//      bridge's `toOwnDeviceViews` maps it; the label is the session name
//      or null, never an id;
//  D2  this device is never removable (by device id or by session);
//  D3  the signing device is never removable, nor a session it shares;
//  D4  any other device needs a live session of this account;
//  D5  `entitlement_device_cap` null (unknown) disables "Raise the device
//      limit": never read as 0;
//  D6  0 is unlimited (signs 0); a known ceiling must raise the enforced cap;
//  D7  raising never changes the seats;
//  D8  "Try again" calls `protectedOpen(channelId)`;
//  D9  "Sign out that device" is the stoat.js session delete, guarded; the
//      listing is the bridge's `listOwnDevices` (its 429 policy);
//  D10 no id is ever rendered;
//  D11 the raise wiring and its error mapping;
//  D12 copy and blank-page traps;
//  D13 "Raise the device limit" is signed only on the device that signs
//      the member list (audit LOW-4): disabled anywhere else, with a line
//      saying where to do it; two unknown device ids never match.
//
// Point `PROTECTED_DEVICE_CAP_FILE` at another copy (a known-bad control)
// to check that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { toOwnDeviceViews } from "../../client/e2eeOwnDevices.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  process.env.PROTECTED_DEVICE_CAP_FILE || join(here, "ProtectedDeviceCap.tsx"),
  "utf8",
);

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

interface Row {
  deviceId: string;
  sessionId: string | null;
  sessionName: string | null;
  lastSeenAt: string | null;
  thisDevice: boolean;
  signing: boolean;
}
interface Self {
  deviceId: string | null;
  sessionId: string | null;
  signerDeviceId: string | null;
}
interface RaiseInput {
  entitlement: unknown;
  enforced: unknown;
  listed: readonly string[] | null;
  removed: readonly string[];
  ownerId: string | null;
  pending: boolean;
}
interface Rules {
  deviceCapRows(listing: unknown, self: Self): Row[];
  deviceCapRemovable(
    row: Row,
    rows: readonly Row[],
    currentSessionId: string | null,
    live: (sessionId: string) => boolean,
  ): boolean;
  deviceCapLabel(row: Row): string | null;
  deviceCapRaise(i: RaiseInput): { seats: string[]; deviceCap: number } | null;
  deviceCapOnSigningDevice(
    signerDeviceId: string | null,
    selfDeviceId: string | null,
  ): boolean;
}
const RULE_NAMES = [
  "deviceCapRows",
  "deviceCapRemovable",
  "deviceCapLabel",
  "deviceCapRaise",
  "deviceCapOnSigningDevice",
] as const;

let rulesPromise: Promise<Rules> | null = null;
function loadRules(): Promise<Rules> {
  rulesPromise ??= (async () => {
    const from = source.indexOf(BEGIN);
    const to = source.indexOf(END);
    assert.ok(from !== -1 && to > from, "protected-pure region missing");
    const region = source.slice(from, to);
    assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
    const js =
      stripTypeScriptTypes(region, { mode: "strip" }) +
      `\nexport { ${RULE_NAMES.join(", ")} };\n`;
    const dir = mkdtempSync(join(tmpdir(), "s2w43-U6-"));
    const out = join(dir, "protectedDeviceCapPure.mjs");
    writeFileSync(out, js);
    const mod = (await import(pathToFileURL(out).href)) as Record<
      string,
      unknown
    >;
    for (const name of RULE_NAMES) {
      assert.equal(typeof mod[name], "function", `${name} missing`);
    }
    return mod as unknown as Rules;
  })();
  return rulesPromise;
}

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(source);

/** The component body: from its declaration to the pure region. */
function componentBody(): string {
  const from = source.indexOf("export function ProtectedDeviceCapModal(");
  assert.ok(from !== -1, "ProtectedDeviceCapModal missing");
  const to = source.indexOf(BEGIN, from);
  assert.ok(to > from, "the component must precede the pure region");
  return code(source.slice(from, to));
}

const BODY = componentBody();

/** One inner function of the component, from `head` to its closing brace. */
function fn(head: string): string {
  const from = BODY.indexOf(head);
  assert.ok(from !== -1, `${head} missing`);
  const to = BODY.indexOf("\n  }\n", from);
  assert.ok(to > from, `${head} has no end`);
  return BODY.slice(from, to);
}

// Fixture ids: none of them may ever come back as a label.
const THIS = "dev-this-0001";
const SIGNER = "dev-signer-0002";
const OTHER = "dev-other-0003";
const BARE = "dev-bare-0004";
const S_THIS = "sess-this";
const S_SIGNER = "sess-signer";
const S_OTHER = "sess-other";
const IDS = [THIS, SIGNER, OTHER, BARE, S_THIS, S_SIGNER, S_OTHER];

const LISTING = [
  {
    device_id: OTHER,
    session_id: S_OTHER,
    session_name: "Laptop",
    last_seen_at: "2026-11-01T10:00:00.000Z",
    curve25519_key: "k",
  },
  { device_id: SIGNER, session_id: S_SIGNER, session_name: "Desktop" },
  { device_id: THIS, session_id: S_THIS, session_name: "  " },
  // bound to no session: the server sends neither field
  { device_id: BARE },
  // dropped: a repeated id, no id, not an object
  { device_id: OTHER, session_id: "sess-dup", session_name: "Dup" },
  { session_id: "sess-noid", session_name: "No id" },
  "junk",
];
const SELF: Self = {
  deviceId: THIS,
  sessionId: S_THIS,
  signerDeviceId: SIGNER,
};
const allLive = () => true;

/** The bridge's views of a raw listing, as `listOwnDevices` maps it. */
const viewsOf = (listing: unknown, me: string | null = THIS) =>
  toOwnDeviceViews(listing, me);

function row(over: Partial<Row>): Row {
  return {
    deviceId: OTHER,
    sessionId: S_OTHER,
    sessionName: "Laptop",
    lastSeenAt: null,
    thisDevice: false,
    signing: false,
    ...over,
  };
}

test("D1 rows come from the own listing; a label is a session name or null, never an id", async () => {
  const r = await loadRules();
  const rows = r.deviceCapRows(viewsOf(LISTING), SELF);
  assert.deepEqual(
    rows.map((x) => [x.deviceId, x.thisDevice, x.signing]),
    [
      [THIS, true, false],
      [SIGNER, false, true],
      [OTHER, false, false],
      [BARE, false, false],
    ],
    "this device, then the signer, then listing order; junk dropped",
  );
  const other = rows.find((x) => x.deviceId === OTHER)!;
  assert.equal(other.sessionId, S_OTHER, "the first row for an id wins");
  assert.equal(other.lastSeenAt, "2026-11-01T10:00:00.000Z");
  assert.equal(r.deviceCapLabel(other), "Laptop");
  assert.equal(r.deviceCapLabel(rows[0]), null, "a blank name is no name");
  const bare = rows.find((x) => x.deviceId === BARE)!;
  assert.equal(bare.sessionId, null);
  assert.equal(r.deviceCapLabel(bare), null);
  // A name without a session is not trusted as one.
  const [orphan] = r.deviceCapRows(
    viewsOf([{ device_id: BARE, session_name: "Ghost" }]),
    SELF,
  );
  assert.equal(r.deviceCapLabel(orphan), null);
  for (const x of [...rows, orphan]) {
    const label = r.deviceCapLabel(x);
    if (label === null) continue;
    assert.ok(!IDS.includes(label), `id as label: ${label}`);
    assert.notEqual(label, x.deviceId);
    assert.notEqual(label, x.sessionId);
  }
  assert.deepEqual(r.deviceCapRows(null, SELF), []);
  assert.deepEqual(r.deviceCapRows({ deviceId: OTHER }, SELF), []);
  // Raw listing rows are not views: nothing is read from snake_case.
  assert.deepEqual(r.deviceCapRows(LISTING, SELF), []);
});

test("D2 this device is never removable", async () => {
  const r = await loadRules();
  // By device id, even when its session is live and not the current one.
  const byDevice = row({
    deviceId: THIS,
    sessionId: "sess-x",
    thisDevice: true,
  });
  assert.equal(
    r.deviceCapRemovable(byDevice, [byDevice], S_THIS, allLive),
    false,
  );
  // By session: a row bound to the current session is this device.
  const rows = r.deviceCapRows(
    viewsOf(
      [{ device_id: "dev-y", session_id: S_THIS, session_name: "Here" }],
      null,
    ),
    { deviceId: null, sessionId: S_THIS, signerDeviceId: null },
  );
  assert.equal(rows[0].thisDevice, true);
  assert.equal(r.deviceCapRemovable(rows[0], rows, S_THIS, allLive), false);
  // By the bridge's own `isThisDevice`, even with this device's id unknown
  // here and a session that isn't the current one.
  const flagged = r.deviceCapRows(
    viewsOf([{ device_id: "dev-z", session_id: "sess-z" }], "dev-z"),
    { deviceId: null, sessionId: S_THIS, signerDeviceId: null },
  );
  assert.equal(flagged[0].thisDevice, true);
  assert.equal(
    r.deviceCapRemovable(flagged[0], flagged, S_THIS, allLive),
    false,
  );
  // The current session is never offered, whatever the row says.
  const current = row({ sessionId: S_THIS });
  assert.equal(
    r.deviceCapRemovable(current, [current], S_THIS, allLive),
    false,
  );
  // Without a known current session nothing is offered.
  const other = row({});
  assert.equal(r.deviceCapRemovable(other, [other], null, allLive), false);
  const listed = r.deviceCapRows(viewsOf(LISTING), SELF);
  const mine = listed.find((x) => x.deviceId === THIS)!;
  assert.equal(r.deviceCapRemovable(mine, listed, S_THIS, allLive), false);
});

test("D3 the signing device is never removable, nor a session it shares", async () => {
  const r = await loadRules();
  const rows = r.deviceCapRows(viewsOf(LISTING), SELF);
  const signer = rows.find((x) => x.deviceId === SIGNER)!;
  assert.equal(signer.signing, true);
  assert.equal(r.deviceCapRemovable(signer, rows, S_THIS, allLive), false);
  // Another device on the signer's session: deleting it signs the signer out.
  const shared = r.deviceCapRows(
    viewsOf([
      { device_id: SIGNER, session_id: S_SIGNER, session_name: "Desktop" },
      { device_id: OTHER, session_id: S_SIGNER, session_name: "Desktop 2" },
    ]),
    SELF,
  );
  assert.equal(shared[1].signing, false);
  assert.equal(r.deviceCapRemovable(shared[1], shared, S_THIS, allLive), false);
  // Not this account's list signer (no signer id): an ordinary device.
  const plain = r.deviceCapRows(viewsOf(LISTING), {
    ...SELF,
    signerDeviceId: null,
  });
  const was = plain.find((x) => x.deviceId === SIGNER)!;
  assert.equal(was.signing, false);
  assert.equal(r.deviceCapRemovable(was, plain, S_THIS, allLive), true);
});

test("D4 another device needs a live session of this account", async () => {
  const r = await loadRules();
  const rows = r.deviceCapRows(viewsOf(LISTING), SELF);
  const other = rows.find((x) => x.deviceId === OTHER)!;
  assert.equal(r.deviceCapRemovable(other, rows, S_THIS, allLive), true);
  const seen: string[] = [];
  assert.equal(
    r.deviceCapRemovable(other, rows, S_THIS, (id) => {
      seen.push(id);
      return false;
    }),
    false,
    "a session this client doesn't hold is never offered",
  );
  assert.deepEqual(seen, [S_OTHER]);
  const bare = rows.find((x) => x.deviceId === BARE)!;
  assert.equal(r.deviceCapRemovable(bare, rows, S_THIS, allLive), false);
});

const RAISE: RaiseInput = {
  entitlement: 8,
  enforced: 5,
  listed: ["owner", "a", "b"],
  removed: [],
  ownerId: "owner",
  pending: false,
};

test("D5 an unknown (null) entitlement disables Raise; never read as 0", async () => {
  const r = await loadRules();
  for (const entitlement of [null, undefined, -1, 1.5, "8", Number.NaN]) {
    for (const enforced of [1, 5, 99]) {
      assert.equal(
        r.deviceCapRaise({ ...RAISE, entitlement, enforced }),
        null,
        `entitlement ${String(entitlement)} enforced ${enforced}`,
      );
    }
  }
});

test("D6 0 is unlimited and signs 0; a known ceiling must raise the enforced cap", async () => {
  const r = await loadRules();
  assert.deepEqual(r.deviceCapRaise({ ...RAISE, entitlement: 0 }), {
    seats: ["owner", "a", "b"],
    deviceCap: 0,
  });
  assert.deepEqual(r.deviceCapRaise(RAISE)?.deviceCap, 8);
  assert.equal(r.deviceCapRaise({ ...RAISE, entitlement: 5 }), null, "at it");
  assert.equal(r.deviceCapRaise({ ...RAISE, entitlement: 4 }), null, "below");
  // Already unlimited, or no list (no enforced cap): nothing to raise.
  assert.equal(r.deviceCapRaise({ ...RAISE, enforced: 0 }), null);
  assert.equal(
    r.deviceCapRaise({ ...RAISE, entitlement: 0, enforced: 0 }),
    null,
  );
  assert.equal(r.deviceCapRaise({ ...RAISE, enforced: null }), null);
});

test("D7 raising never changes the seats", async () => {
  const r = await loadRules();
  assert.deepEqual(
    r.deviceCapRaise({ ...RAISE, listed: ["a", "owner", "b", "a"] })?.seats,
    ["owner", "a", "b"],
    "the signed seats, owner first, no duplicates",
  );
  assert.equal(r.deviceCapRaise({ ...RAISE, listed: null }), null);
  assert.equal(r.deviceCapRaise({ ...RAISE, removed: ["b"] }), null);
  assert.equal(r.deviceCapRaise({ ...RAISE, pending: true }), null);
  assert.equal(r.deviceCapRaise({ ...RAISE, ownerId: null }), null);
});

test("D8 Try again asks the bridge to open the channel", () => {
  const body = fn("function tryAgain() {");
  assert.match(body, /^\s*ui\(\)\?\.protectedOpen\(props\.channel\.id\);$/m);
  assert.match(
    BODY,
    /text: <Trans>Try again<\/Trans>,\s*onClick: \(\) => \{\s*tryAgain\(\);\s*return false;\s*\},/,
  );
  // A raise that went through retries the same way.
  assert.match(
    fn("async function raise() {"),
    /\} finally \{\s*setBusy\(false\);\s*\}\s*tryAgain\(\);$/,
  );
});

test("D9 Sign out that device is the stoat.js session delete, guarded", () => {
  const body = fn("async function signOut(row: DeviceCapRow) {");
  assert.match(body, /^\s*if \(busy\(\) \|\| !removable\(row\)\) return;$/m);
  assert.match(body, /client\(\)\.sessions\.get\(row\.sessionId\)/);
  assert.match(body, /if \(!session \|\| session\.current\) return;/);
  assert.match(body, /await session\.delete\(\);/);
  assert.match(
    BODY,
    /deviceCapRemovable\(row, rows\(\), currentSessionId\(\), \(id\) =>\s*client\(\)\.sessions\.has\(id\),?\s*\)/,
  );
  assert.match(
    BODY,
    /currentSessionId = \(\) => client\(\)\?\.sessionId \?\? null/,
  );
  assert.match(BODY, /deviceId: ui\(\)\?\.selfDeviceId\(\) \?\? null,/);
  assert.match(BODY, /signerDeviceId: signerDeviceId\(\),/);
  assert.match(BODY, /list\.signer_user_id === me/);
  // Both sign-out buttons sit behind the rule.
  assert.equal(
    (BODY.match(/<Show when=\{removable\(row\) && /g) ?? []).length,
    2,
  );
  assert.doesNotMatch(CODE, /\bdeleteAll\b/, "never every session");
  assert.doesNotMatch(CODE, /\/auth\/session/, "only through stoat.js");
  // The listing is the bridge's own read (its 429 policy), never a raw one.
  const load = fn("async function load() {");
  assert.match(load, /const own = await e2ee\.listOwnDevices\(\);/);
  assert.match(load, /setViews\(own\);/);
  assert.match(BODY, /deviceCapRows\(views\(\), \{/);
  assert.doesNotMatch(CODE, /\btextApi\b/, "no direct listing read");
  assert.doesNotMatch(CODE, /(?<![.\w])fetch\(/, "no raw fetch");
  assert.doesNotMatch(CODE, /\/e2ee\/devices/, "no route of its own");
});

test("D10 no id is ever rendered", () => {
  assert.match(
    BODY,
    /const name = \(\) => deviceCapLabel\(row\) \?\? t`Unnamed device`;/,
  );
  assert.match(BODY, /<DeviceName>\{name\(\)\}<\/DeviceName>/);
  // Ids appear only in comparisons and calls, never as a JSX child.
  for (const m of BODY.matchAll(/>\s*\{([^{}]*)\}\s*</g)) {
    assert.doesNotMatch(
      m[1],
      /\b(deviceId|sessionId|signer_device_id|signer_user_id|user_id|session_id|id)\b/,
      `rendered: ${m[1]}`,
    );
  }
  assert.doesNotMatch(BODY, /\bsessionName\b/, "only through the label");
});

test("D11 raise: owner only, disabled without a plan, errors mapped", () => {
  assert.match(
    BODY,
    /<Show when=\{viewerIsOwner\(\)\}>\s*<OwnerLine>\s*<Button\s+size="sm"\s+variant="tonal"\s+isDisabled=\{busy\(\) \|\| raisePlan\(\) === null\}\s+onPress=\{\(\) => void raise\(\)\}\s*>\s*\{t`Raise the device limit`\}/,
  );
  const plan = BODY.slice(BODY.indexOf("const raisePlan = createMemo("));
  for (const line of [
    /entitlement: snap\.entitlement_device_cap,/,
    /enforced: snap\.device_cap,/,
    /listed: listSeatIds\(snap\.list\?\.body\),/,
    /removed: serverRemovedSeatIds\(snap, owner\),/,
    /pending: api\.pendingSeats\(props\.channel\.id\) !== null,/,
  ]) {
    assert.match(plan, line);
  }
  assert.match(plan, /if \(!viewerIsOwner\(\) \|\| api === null/);
  const raise = fn("async function raise() {");
  assert.match(
    raise,
    /await api\.setSeats\(props\.channel\.id, plan\.seats, plan\.deviceCap\);/,
  );
  assert.match(
    raise,
    /if \(busy\(\) \|\| plan === null \|\| api === null\) return;/,
  );
  assert.match(
    raise,
    /errorUiCopy\(answer, \{ removedUserNames: displayNames, failure: err \}\)/,
  );
  assert.match(
    BODY,
    /return protectedNoticeForError\(err, \{ op: "owner" \}\);/,
  );
  assert.doesNotMatch(CODE, /\.message\b/, "never read an error's message");
  assert.doesNotMatch(CODE, /\bshowError\b/, "never the generic error modal");
  assert.doesNotMatch(CODE, /String\(err/, "never stringify the error");
});

test("D13 rule: only this account's signing device, and never two unknowns", async () => {
  const r = await loadRules();
  assert.equal(r.deviceCapOnSigningDevice(SIGNER, SIGNER), true);
  assert.equal(r.deviceCapOnSigningDevice(SIGNER, THIS), false);
  // The list is not this account's (no signer id) or not loaded yet.
  assert.equal(r.deviceCapOnSigningDevice(null, THIS), false);
  // This device's id is unknown.
  assert.equal(r.deviceCapOnSigningDevice(SIGNER, null), false);
  assert.equal(r.deviceCapOnSigningDevice(null, null), false);
});

test("D13 wiring: Raise is disabled off the signing device, and a line says where", () => {
  assert.match(
    BODY,
    /const onSigningDevice = \(\) =>\s*deviceCapOnSigningDevice\(signerDeviceId\(\), ui\(\)\?\.selfDeviceId\(\) \?\? null\);/,
  );
  // The plan is null off the signing device: the button's isDisabled
  // (`raisePlan() === null`, D11) and raise()'s own guard both follow.
  const plan = BODY.slice(
    BODY.indexOf("const raisePlan = createMemo("),
    BODY.indexOf("return deviceCapRaise({"),
  );
  assert.match(plan, /^\s*if \(!onSigningDevice\(\)\) return null;$/m);
  // Right after the owner line, closing the owner-only block (D11 pins its
  // opening `<Show when={viewerIsOwner()}>`): a member never sees it.
  assert.match(
    BODY,
    /<\/OwnerLine>\s*<Show when=\{!onSigningDevice\(\)\}>\s*<Description>\s*\{t`Raise the limit from the device that signs this channel's member list\.`\}\s*<\/Description>\s*<\/Show>\s*<\/Show>/,
  );
});

test("D12 copy and blank-page traps", () => {
  assert.match(
    BODY,
    /title=\{noticeCopy\("capacity_device_cap", null, null, props\.channel\.name\)\}/,
  );
  // JSX text children must be expressions or <Trans>: no bare English.
  const bare = [...BODY.matchAll(/>\s*([A-Za-z][^<>{}();=]*?)\s*</g)].map(
    (m) => m[1],
  );
  assert.deepEqual(bare, [
    "Close",
    "Try again",
    "This device",
    "Cancel",
    "Sign out",
  ]);
  // Local msgids (reported to L9; "Last seen" is the catalog's own).
  assert.deepEqual(
    [...BODY.matchAll(/\bt`([^`]*)`/g)].map((m) => m[1]),
    [
      "Last seen ${seenAgo}",
      "Couldn't sign out that device. Try again.",
      "Sign out one of your other devices to make room for this one, then try again.",
      "Unnamed device",
      "Signs this channel's member list",
      "Sign out that device",
      "That device will be signed out and will have to sign in again.",
      "Raise the device limit",
      "Raise the limit from the device that signs this channel's member list.",
    ],
  );
  assert.doesNotMatch(
    CODE,
    /\bstyled\(\s*[A-Z]/,
    "styled(Component) at module scope",
  );
  assert.doesNotMatch(CODE, /from "@revolt\/ui";/, "@revolt/ui barrel import");
  assert.doesNotMatch(CODE, /features\/legacy/, "legacy barrel");
  assert.doesNotMatch(CODE, /use:floating/);
});
